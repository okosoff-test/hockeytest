const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

const seedPlayers = [
 ['Francesco','Aiuto',false],['Sean','Antaya',false],['Brett','Boissonneau',false],['Derek','Boissonneau',false],
 ['Dj','Cassady',false],['Luca','Cavallaro',false],['Phong','Chau',false],['Larry','Cichon',false],
 ['Anthony','Derose',false],['Jeyden','Edwards',false],['Marc','Frey',false],['Kaoru','Geddes',false],
 ['Spencer','Gereige',false],['Brad','Gervais',false],['Matthew','Glavine',false],['Jesse','Gouin',false],
 ['Jason','Haskett',false],['Daniel','Hrubik',false],['Maurice','Hung',false],['Sean','Ivany',false],
 ['Ethan','Lafontaine',false],['Phan','Ly',false],['Drew','Menard',false],['Ferd','Mireault',false],
 ['Kevin','Richter',false],['Justin','Simard',false],['Kyle','Smith',false],['John','Srnec',false],
 ['Mat','Carriere',true],['Hao','Chau',true],['Lilly','Isberg',true],['Craig','Scolack',true]
];

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id=1), ratings_open BOOLEAN NOT NULL DEFAULT TRUE
  )`);
  await pool.query(`INSERT INTO settings (id, ratings_open) VALUES (1, TRUE) ON CONFLICT (id) DO NOTHING`);
  await pool.query(`CREATE TABLE IF NOT EXISTS players (
    id SERIAL PRIMARY KEY, first_name TEXT NOT NULL, last_name TEXT NOT NULL, is_goalie BOOLEAN NOT NULL DEFAULT FALSE,
    photo BYTEA, photo_type TEXT, completed BOOLEAN NOT NULL DEFAULT FALSE, completed_at TIMESTAMPTZ,
    UNIQUE(first_name,last_name)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS ratings (
    id SERIAL PRIMARY KEY, rater_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    rated_id INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    score NUMERIC(3,1) NOT NULL CHECK(score>=1 AND score<=10), created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(rater_id,rated_id), CHECK(rater_id<>rated_id)
  )`);
  for (const [first,last,goalie] of seedPlayers) {
    await pool.query(`INSERT INTO players(first_name,last_name,is_goalie) VALUES($1,$2,$3)
      ON CONFLICT(first_name,last_name) DO UPDATE SET is_goalie=EXCLUDED.is_goalie`, [first,last,goalie]);
  }
}

function adminOk(req) { return req.headers['x-admin-password'] === ADMIN_PASSWORD; }
function requireAdmin(req,res,next){ if(!adminOk(req)) return res.status(401).json({error:'Invalid admin password'}); next(); }

app.get('/api/status', async (_req,res) => {
  const s = await pool.query('SELECT ratings_open FROM settings WHERE id=1');
  res.json({open:s.rows[0].ratings_open});
});
app.get('/api/players', async (_req,res) => {
  const s = await pool.query('SELECT ratings_open FROM settings WHERE id=1');
  if(!s.rows[0].ratings_open) return res.status(403).json({error:'Player ratings are currently closed.'});
  const q = await pool.query(`SELECT id,first_name,last_name,is_goalie,completed,(photo IS NOT NULL) AS has_photo
    FROM players ORDER BY is_goalie, last_name, first_name`);
  res.json(q.rows);
});
app.get('/api/photo/:id', async (req,res) => {
  const q=await pool.query('SELECT photo,photo_type FROM players WHERE id=$1',[req.params.id]);
  if(!q.rows[0] || !q.rows[0].photo) return res.status(404).end();
  res.type(q.rows[0].photo_type || 'image/jpeg').send(q.rows[0].photo);
});
app.post('/api/photo/:id', upload.single('photo'), async (req,res) => {
  const s=await pool.query('SELECT ratings_open FROM settings WHERE id=1');
  if(!s.rows[0].ratings_open) return res.status(403).json({error:'Ratings are closed.'});
  if(!req.file) return res.status(400).json({error:'Choose a photo.'});
  const exists=await pool.query('SELECT completed FROM players WHERE id=$1',[req.params.id]);
  if(!exists.rows[0]) return res.status(404).json({error:'Player not found.'});
  if(exists.rows[0].completed) return res.status(409).json({error:'This player has already submitted.'});
  const photo=await sharp(req.file.buffer).rotate().resize(320,320,{fit:'cover'}).jpeg({quality:78}).toBuffer();
  await pool.query('UPDATE players SET photo=$1,photo_type=$2 WHERE id=$3',[photo,'image/jpeg',req.params.id]);
  res.json({ok:true});
});
app.get('/api/rate/:raterId', async (req,res) => {
  const s=await pool.query('SELECT ratings_open FROM settings WHERE id=1');
  if(!s.rows[0].ratings_open) return res.status(403).json({error:'Ratings are closed.'});
  const r=await pool.query('SELECT id,first_name,last_name,is_goalie,completed,(photo IS NOT NULL) AS has_photo FROM players WHERE id=$1',[req.params.raterId]);
  if(!r.rows[0]) return res.status(404).json({error:'Player not found.'});
  if(r.rows[0].completed) return res.status(409).json({error:'This player has already submitted.'});
  const q=await pool.query(`SELECT p.id,p.first_name,p.last_name,p.is_goalie,(p.photo IS NOT NULL) AS has_photo,rt.score
    FROM players p LEFT JOIN ratings rt ON rt.rated_id=p.id AND rt.rater_id=$1
    WHERE p.id<>$1 ORDER BY p.is_goalie,p.last_name,p.first_name`,[req.params.raterId]);
  res.json({rater:r.rows[0],players:q.rows});
});

app.post('/api/save/:raterId', async (req,res) => {
  const s=await pool.query('SELECT ratings_open FROM settings WHERE id=1');
  if(!s.rows[0].ratings_open) return res.status(403).json({error:'Ratings are closed.'});
  const r=await pool.query('SELECT completed FROM players WHERE id=$1',[req.params.raterId]);
  if(!r.rows[0]) return res.status(404).json({error:'Player not found.'});
  if(r.rows[0].completed) return res.status(409).json({error:'This player has already submitted.'});
  const ratedId=Number(req.body.ratedId); const score=Number(req.body.score);
  if(!Number.isInteger(ratedId)||ratedId===Number(req.params.raterId)||!Number.isFinite(score)||score<1||score>10)
    return res.status(400).json({error:'Invalid rating.'});
  const target=await pool.query('SELECT 1 FROM players WHERE id=$1',[ratedId]);
  if(!target.rows[0]) return res.status(404).json({error:'Rated player not found.'});
  await pool.query(`INSERT INTO ratings(rater_id,rated_id,score) VALUES($1,$2,$3)
    ON CONFLICT(rater_id,rated_id) DO UPDATE SET score=EXCLUDED.score,created_at=NOW()`,[req.params.raterId,ratedId,score]);
  res.json({ok:true});
});

app.post('/api/submit/:raterId', async (req,res) => {
  const s=await pool.query('SELECT ratings_open FROM settings WHERE id=1');
  if(!s.rows[0].ratings_open) return res.status(403).json({error:'Ratings are closed.'});
  const {ratings}=req.body;
  if(!Array.isArray(ratings)) return res.status(400).json({error:'Ratings are required.'});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const r=await client.query('SELECT completed,(photo IS NOT NULL) AS has_photo FROM players WHERE id=$1 FOR UPDATE',[req.params.raterId]);
    if(!r.rows[0]) throw new Error('Player not found.');
    if(r.rows[0].completed) throw new Error('This player has already submitted.');
    if(!r.rows[0].has_photo) throw new Error('Upload your photo before submitting.');
    const count=await client.query('SELECT COUNT(*)::int AS n FROM players WHERE id<>$1',[req.params.raterId]);
    if(ratings.length!==count.rows[0].n) throw new Error('Every player must be rated.');
    for(const item of ratings){
      const score=Number(item.score); const ratedId=Number(item.ratedId);
      if(!Number.isFinite(score)||score<1||score>10||ratedId===Number(req.params.raterId)) throw new Error('Invalid rating.');
      await client.query(`INSERT INTO ratings(rater_id,rated_id,score) VALUES($1,$2,$3)
        ON CONFLICT(rater_id,rated_id) DO UPDATE SET score=EXCLUDED.score`,[req.params.raterId,ratedId,score]);
    }
    await client.query('UPDATE players SET completed=TRUE,completed_at=NOW() WHERE id=$1',[req.params.raterId]);
    await client.query('COMMIT'); res.json({ok:true});
  } catch(e){ await client.query('ROLLBACK'); res.status(400).json({error:e.message}); }
  finally{ client.release(); }
});

app.get('/api/admin/data',requireAdmin,async(_req,res)=>{
  const s=await pool.query('SELECT ratings_open FROM settings WHERE id=1');
  const p=await pool.query(`SELECT p.id,p.first_name,p.last_name,p.is_goalie,p.completed,p.completed_at,(p.photo IS NOT NULL) AS has_photo,
    ROUND(AVG(r.score),2) AS average,COUNT(r.score)::int AS rating_count
    FROM players p LEFT JOIN ratings r ON r.rated_id=p.id GROUP BY p.id ORDER BY p.is_goalie,p.last_name,p.first_name`);
  res.json({open:s.rows[0].ratings_open,players:p.rows});
});
app.post('/api/admin/toggle',requireAdmin,async(req,res)=>{
  const open=Boolean(req.body.open); await pool.query('UPDATE settings SET ratings_open=$1 WHERE id=1',[open]); res.json({ok:true,open});
});
app.post('/api/admin/reset/:id',requireAdmin,async(req,res)=>{
  const c=await pool.connect(); try{await c.query('BEGIN');await c.query('DELETE FROM ratings WHERE rater_id=$1',[req.params.id]);await c.query('UPDATE players SET completed=FALSE,completed_at=NULL WHERE id=$1',[req.params.id]);await c.query('COMMIT');res.json({ok:true});}catch(e){await c.query('ROLLBACK');res.status(400).json({error:e.message});}finally{c.release();}
});
app.get('/api/admin/export',requireAdmin,async(_req,res)=>{
  const q=await pool.query(`SELECT p.first_name,p.last_name,p.is_goalie,ROUND(AVG(r.score),2) average,COUNT(r.score)::int rating_count
    FROM players p LEFT JOIN ratings r ON r.rated_id=p.id GROUP BY p.id ORDER BY average DESC NULLS LAST,p.last_name`);
  const lines=['Name,Goalie,Average,Rating Count',...q.rows.map(x=>`"${x.first_name} ${x.last_name}",${x.is_goalie?'Yes':'No'},${x.average||''},${x.rating_count}`)];
  res.type('text/csv').attachment('player-ratings.csv').send(lines.join('\n'));
});

app.get('/admin',(_req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('*',(_req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));

initDb().then(()=>app.listen(process.env.PORT||3000,()=>console.log('Player ratings site running'))).catch(e=>{console.error(e);process.exit(1)});
