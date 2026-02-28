const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const { Pool } = require('pg');
const app = express();
const PORT = process.env.PORT || 3000;

// Database setup with enhanced configuration
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
    max: 20,
    min: 2,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    maxUses: 7500
});

// Handle pool errors
pool.on('error', (err, client) => {
    console.error('Unexpected PostgreSQL pool error:', err.message);
});

// Log connection events in development
if (process.env.NODE_ENV !== 'production') {
    pool.on('connect', () => {
        console.log('New PostgreSQL connection created. Total:', pool.totalCount);
    });
    pool.on('remove', () => {
        console.log('PostgreSQL connection removed. Total:', pool.totalCount);
    });
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// --- DATA STORE ---
let playerSpots = 20;
let players = []; 
let waitlist = [];
const ADMIN_PASSWORD = "964888";

// Game details - SUNDAY HOCKEY
let gameLocation = "WFCU Greenshield";
let gameTime = "Sunday 8:30 PM";
let gameDate = "";

// Player signup password protection - FIXED DEFAULT CODE
let playerSignupCode = '7666';
let requirePlayerCode = true;
let manualOverride = false;
let manualOverrideState = null;

// Store admin sessions
let adminSessions = {};

// Weekly reset tracking
let lastResetWeek = null;
let rosterReleased = false;
let currentWeekData = {
    weekNumber: null,
    year: null,
    releaseDate: null,
    rosterReleaseTime: null,
    whiteTeam: [],
    darkTeam: []
};

const MAX_GOALIES = 2;

const GAME_RULES = [
    "No Contact, may tie up player along board plays.",
    "Keep negative comments to yourself.",
    "Pass the puck!",
    "Don't stick handle around everyone each and every shift. Don't be a hotdog.",
    "Shift OFF often.",
    "No slashing period., lift the bloody stick. If you slash, intentional or not and hurt the opposing player. You are done for the night and future infraction will end in being Banned period.",
    "Skate hard, shift off when you're huffing and puffing.",
    "Don't need to be overly aggressive, tone down the aggression. If pickup hockey.",
    "Slap shots, don't take it if you can't control it. If you hit goalies in the head, or hurt anyone, you are banned from taking slapshots.",
    "Have fun! And don't forget Traditional Handshake/Fist bump when game ends!"
];

// --- AUTO-ADD PLAYERS CONFIG ---
const AUTO_ADD_PLAYERS = [
    {
        firstName: "Phan",
        lastName: "Ly",
        phone: "(519) 564-1868",
        rating: 7,
        isGoalie: false,
        isFree: true,
        paymentMethod: "FREE"
    },
    {
        firstName: "Craig",
        lastName: "Scolak",
        phone: "(519) 982-6311",
        rating: 9,
        isGoalie: true,
        isFree: false,
        paymentMethod: "N/A"
    },
    {
        firstName: "Mat",
        lastName: "Carriere",
        phone: "(226) 350-0217",
        rating: 7,
        isGoalie: true,
        isFree: false,
        paymentMethod: "N/A"
    }
];

// --- TIME FUNCTIONS ---

function getCurrentETTime() {
    const now = new Date();
    const etString = now.toLocaleString('en-US', {
        timeZone: 'America/New_York',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    
    const [datePart, timePart] = etString.split(', ');
    const [month, day, year] = datePart.split('/').map(Number);
    const [hour, minute, second] = timePart.split(':').map(Number);
    
    const etDate = new Date(year, month - 1, day, hour, minute, second);
    return etDate;
}

function getWeekNumber(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return {
        week: Math.ceil((((d - yearStart) / 86400000) + 1) / 7),
        year: d.getUTCFullYear()
    };
}

// SUNDAY HOCKEY SCHEDULE: Locked Sunday 5pm - Wednesday 5pm
function shouldBeLocked() {
    const etTime = getCurrentETTime();
    const day = etTime.getDay();
    const hour = etTime.getHours();
    
    // Sunday 5pm (17:00) onwards until Wednesday 5pm (17:00)
    if (day === 0 && hour >= 17) return true;  // Sunday 5pm+
    if (day === 1) return true;  // Monday all day
    if (day === 2) return true;  // Tuesday all day
    if (day === 3 && hour < 17) return true;  // Wednesday until 5pm
    if (rosterReleased && day === 0 && hour >= 17) return true;
    
    return false;
}

function checkAutoLock() {
    const etTime = getCurrentETTime();
    const day = etTime.getDay();
    const hour = etTime.getHours();
    
    if (rosterReleased) {
        if ((day === 0 && hour >= 17) || day === 1 || day === 2 || (day === 3 && hour < 17)) {
            if (manualOverride && manualOverrideState === 'open') {
                if (requirePlayerCode) {
                    requirePlayerCode = false;
                    saveData();
                }
                return { 
                    requirePlayerCode: false, 
                    manualOverride: true, 
                    manualOverrideState: manualOverrideState,
                    isLockedWindow: true,
                    rosterReleased: true 
                };
            }
            
            if (!requirePlayerCode) {
                requirePlayerCode = true;
                manualOverride = false;
                manualOverrideState = null;
                saveData();
            }
            return { 
                requirePlayerCode: true, 
                manualOverride: false, 
                manualOverrideState: null,
                isLockedWindow: true,
                rosterReleased: true 
            };
        }
    }
    
    const shouldLock = shouldBeLocked();
    
    if (manualOverride && manualOverrideState) {
        if (manualOverrideState === 'locked') {
            if (!requirePlayerCode) {
                requirePlayerCode = true;
                saveData();
            }
            return { 
                requirePlayerCode: true, 
                manualOverride: true, 
                manualOverrideState: 'locked',
                isLockedWindow: shouldLock,
                rosterReleased 
            };
        } else if (manualOverrideState === 'open') {
            if (requirePlayerCode) {
                requirePlayerCode = false;
                saveData();
            }
            return { 
                requirePlayerCode: false, 
                manualOverride: true, 
                manualOverrideState: 'open',
                isLockedWindow: shouldLock,
                rosterReleased 
            };
        }
    }
    
    if (shouldLock) {
        if (!requirePlayerCode) {
            requirePlayerCode = true;
            saveData();
        }
    } else {
        // Don't auto-unlock if roster is released and was manually locked
        if (requirePlayerCode && !(rosterReleased && manualOverride && manualOverrideState === 'locked')) {
            requirePlayerCode = false;
            saveData();
        }
    }
    
    return { 
        requirePlayerCode, 
        manualOverride: false, 
        manualOverrideState: null,
        isLockedWindow: shouldLock,
        rosterReleased 
    };
}

// Auto-release roster on Sunday at 5pm
async function autoReleaseRoster() {
    const etTime = getCurrentETTime();
    const day = etTime.getDay();
    const hour = etTime.getHours();
    const minute = etTime.getMinutes();
    
    if (day === 0 && hour === 17 && minute === 0 && !rosterReleased && players.length > 0) {
        try {
            const { week, year } = getWeekNumber(etTime);
            const teams = generateFairTeams();
            
            rosterReleased = true;
            requirePlayerCode = true;
            manualOverride = true;  // Keep locked after auto-release
            manualOverrideState = 'locked';  // Force locked state
            
            currentWeekData = {
                weekNumber: week,
                year: year,
                releaseDate: new Date().toISOString(),
                rosterReleaseTime: Date.now(),
                whiteTeam: teams.whiteTeam,
                darkTeam: teams.darkTeam
            };
            
            for (const player of players) {
                await pool.query('UPDATE players SET team = $1 WHERE id = $2', [player.team, player.id]);
            }
            
            await saveWeekHistory(year, week, teams.whiteTeam, teams.darkTeam);
            await saveData();
            
        } catch (error) {
            console.error('Auto-release error:', error);
        }
    }
}

// --- AUTO-ADD PLAYERS FUNCTION ---
async function addAutoPlayers() {
    console.log('Adding auto-players for new week...');
    let addedCount = 0;
    
    for (const autoPlayer of AUTO_ADD_PLAYERS) {
        // Check if player already exists
        const normalizedName = (autoPlayer.firstName + ' ' + autoPlayer.lastName).toLowerCase().trim();
        const normalizedPhone = autoPlayer.phone.replace(/\D/g, '');
        
        const exists = players.find(p => 
            (p.firstName + ' ' + p.lastName).toLowerCase().trim() === normalizedName ||
            p.phone.replace(/\D/g, '') === normalizedPhone
        );
        
        if (exists) {
            console.log(`${autoPlayer.firstName} ${autoPlayer.lastName} already exists, skipping.`);
            continue;
        }
        
        const newPlayer = {
            id: Date.now() + Math.floor(Math.random() * 1000),
            firstName: autoPlayer.firstName,
            lastName: autoPlayer.lastName,
            phone: autoPlayer.phone,
            paymentMethod: autoPlayer.paymentMethod,
            paid: autoPlayer.isFree ? true : false,
            paidAmount: autoPlayer.isFree ? 0 : null,
            rating: autoPlayer.rating,
            isGoalie: autoPlayer.isGoalie,
            team: null,
            registeredAt: new Date().toISOString(),
            rulesAgreed: true
        };
        
        try {
            await pool.query(
                `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team, rules_agreed)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
                 newPlayer.paymentMethod, newPlayer.paid, newPlayer.paidAmount, newPlayer.rating, 
                 autoPlayer.isGoalie, null, true]
            );
            players.push(newPlayer);
            
            if (!autoPlayer.isGoalie) {
                playerSpots--;
            }
            
            addedCount++;
            console.log(`Added ${autoPlayer.firstName} ${autoPlayer.lastName}`);
        } catch (err) {
            console.error(`Error adding ${autoPlayer.firstName} ${autoPlayer.lastName}:`, err);
        }
    }
    
    if (addedCount > 0) {
        await saveData();
    }
    console.log(`Auto-added ${addedCount} players`);
    return addedCount;
}

// Weekly reset - Sunday at 11:58PM
function checkWeeklyReset() {
    const etTime = getCurrentETTime();
    const { week: currentWeek, year: currentYear } = getWeekNumber(etTime);
    const day = etTime.getDay();
    const hour = etTime.getHours();
    const minute = etTime.getMinutes();
    
    // Reset on Sunday at 11:58PM
    if (day === 0 && hour === 23 && minute === 58 && (lastResetWeek !== currentWeek || currentWeekData.year !== currentYear)) {
        if (rosterReleased && currentWeekData.weekNumber && 
            (currentWeekData.whiteTeam.length > 0 || currentWeekData.darkTeam.length > 0)) {
            saveWeekHistory(
                currentWeekData.year,
                currentWeekData.weekNumber,
                currentWeekData.whiteTeam,
                currentWeekData.darkTeam
            );
        }
        
        playerSpots = 20;
        players = []; 
        waitlist = [];
        rosterReleased = false;
        lastResetWeek = currentWeek;
        gameDate = calculateNextSunday();
        
        currentWeekData = {
            weekNumber: currentWeek,
            year: currentYear,
            releaseDate: null,
            whiteTeam: [],
            darkTeam: []
        };
        
        manualOverride = false;
        manualOverrideState = null;
        requirePlayerCode = true;
        
        // Code stays as 7666 - no auto-generation
        
        // Auto-add the predefined players after reset on Sunday 11:58pm
        setTimeout(() => {
            addAutoPlayers().then(() => {
                saveData();
            });
        }, 100);
    }
}

const CHECK_INTERVAL = process.env.NODE_ENV === 'production' ? 30000 : 5000;

setInterval(() => {
    checkAutoLock();
    checkWeeklyReset();
    saveData();
}, CHECK_INTERVAL);

// --- DATABASE FUNCTIONS ---

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS settings (
                key VARCHAR(50) PRIMARY KEY,
                value JSONB NOT NULL
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS players (
                id BIGINT PRIMARY KEY,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20),
                paid BOOLEAN DEFAULT false,
                paid_amount NUMERIC(10,2),
                rating INTEGER NOT NULL,
                is_goalie BOOLEAN DEFAULT false,
                team VARCHAR(10),
                registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                rules_agreed BOOLEAN DEFAULT false
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS waitlist (
                id BIGINT PRIMARY KEY,
                first_name VARCHAR(100) NOT NULL,
                last_name VARCHAR(100) NOT NULL,
                phone VARCHAR(20) NOT NULL,
                payment_method VARCHAR(20),
                rating INTEGER NOT NULL,
                is_goalie BOOLEAN DEFAULT false,
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);
        
        await pool.query(`
            CREATE TABLE IF NOT EXISTS history (
                id SERIAL PRIMARY KEY,
                week_number INTEGER NOT NULL,
                year INTEGER NOT NULL,
                release_date TIMESTAMP NOT NULL,
                game_location VARCHAR(200),
                game_time VARCHAR(50),
                game_date DATE,
                white_team JSONB,
                dark_team JSONB,
                white_avg NUMERIC(3,1),
                dark_avg NUMERIC(3,1)
            )
        `);
        
        await loadDataFromDB();
    } catch (err) {
        console.error('Database initialization error:', err);
        loadDataFromFile();
    }
}

async function loadDataFromDB() {
    try {
        const settingsRes = await pool.query('SELECT * FROM settings');
        const settings = {};
        settingsRes.rows.forEach(row => {
            settings[row.key] = row.value;
        });
        
        if (settings.playerSpots) playerSpots = settings.playerSpots;
        if (settings.gameLocation) gameLocation = settings.gameLocation;
        if (settings.gameTime) gameTime = settings.gameTime;
        if (settings.gameDate) gameDate = settings.gameDate;
        else gameDate = calculateNextSunday(); // FIX: Ensure gameDate is never empty
        if (settings.playerSignupCode) playerSignupCode = settings.playerSignupCode;
        if (settings.requirePlayerCode !== undefined) requirePlayerCode = settings.requirePlayerCode;
        if (settings.manualOverride !== undefined) manualOverride = settings.manualOverride;
        if (settings.manualOverrideState !== undefined) manualOverrideState = settings.manualOverrideState;
        if (settings.lastResetWeek) lastResetWeek = settings.lastResetWeek;
        if (settings.rosterReleased !== undefined) rosterReleased = settings.rosterReleased;
        if (settings.currentWeekData) currentWeekData = settings.currentWeekData;
        
        const playersRes = await pool.query('SELECT * FROM players ORDER BY registered_at');
        players = playersRes.rows.map(p => ({
            id: p.id,
            firstName: p.first_name,
            lastName: p.last_name,
            phone: p.phone,
            paymentMethod: p.payment_method,
            paid: p.paid,
            paidAmount: p.paid_amount,
            rating: p.rating,
            isGoalie: p.is_goalie,
            team: p.team,
            registeredAt: p.registered_at,
            rulesAgreed: p.rules_agreed
        }));
        
        const waitlistRes = await pool.query('SELECT * FROM waitlist ORDER BY joined_at');
        waitlist = waitlistRes.rows.map(p => ({
            id: p.id,
            firstName: p.first_name,
            lastName: p.last_name,
            phone: p.phone,
            paymentMethod: p.payment_method,
            rating: p.rating,
            isGoalie: p.is_goalie,
            joinedAt: p.joined_at
        }));
        
    } catch (err) {
        console.error('Error loading from DB:', err);
        throw err;
    }
}

async function saveSetting(key, value) {
    try {
        await pool.query(
            'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
            [key, JSON.stringify(value)]
        );
    } catch (err) {
        console.error('Error saving setting:', err);
    }
}

async function saveData() {
    try {
        await saveSetting('playerSpots', playerSpots);
        await saveSetting('gameLocation', gameLocation);
        await saveSetting('gameTime', gameTime);
        await saveSetting('gameDate', gameDate);
        await saveSetting('playerSignupCode', playerSignupCode);
        await saveSetting('requirePlayerCode', requirePlayerCode);
        await saveSetting('manualOverride', manualOverride);
        await saveSetting('manualOverrideState', manualOverrideState);
        await saveSetting('lastResetWeek', lastResetWeek);
        await saveSetting('rosterReleased', rosterReleased);
        await saveSetting('currentWeekData', currentWeekData);
    } catch (err) {
        console.error('Error saving data:', err);
    }
}

const DATA_FILE = './data.json';

function generateRandomCode() {
    return Math.floor(1000 + Math.random() * 9000).toString();
}

function loadDataFromFile() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            playerSpots = data.playerSpots ?? 20;
            players = data.players ?? [];
            waitlist = data.waitlist ?? [];
            gameLocation = data.gameLocation ?? "WFCU Greenshield";
            gameTime = data.gameTime ?? "Sunday 8:30 PM";
            gameDate = data.gameDate ?? calculateNextSunday();
            playerSignupCode = data.playerSignupCode ?? '7666';
            requirePlayerCode = data.requirePlayerCode ?? true;
            manualOverride = data.manualOverride ?? false;
            manualOverrideState = data.manualOverrideState ?? null;
            lastResetWeek = data.lastResetWeek ?? null;
            rosterReleased = data.rosterReleased ?? false;
            currentWeekData = data.currentWeekData ?? {
                weekNumber: null,
                year: null,
                releaseDate: null,
                whiteTeam: [],
                darkTeam: []
            };
        } else {
            gameDate = calculateNextSunday();
        }
    } catch (err) {
        console.error('Error loading data:', err);
        gameDate = calculateNextSunday();
    }
}

// FIX: Use ET timezone for calculateNextSunday
function calculateNextSunday() {
    const now = new Date();
    // Convert to ET
    const etNow = new Date(now.toLocaleString("en-US", {timeZone: "America/New_York"}));
    const dayOfWeek = etNow.getDay();
    // Sunday is day 0
    let daysUntilSunday = (0 - dayOfWeek + 7) % 7;
    if (daysUntilSunday === 0 && etNow.getHours() >= 20) {
        daysUntilSunday = 7; // If it's already past Sunday 8pm ET, go to next Sunday
    }
    const nextSunday = new Date(etNow);
    nextSunday.setDate(etNow.getDate() + daysUntilSunday);
    return nextSunday.toISOString().split('T')[0];
}

function formatGameDate(dateString) {
    if (!dateString) return "TBD";
    const date = new Date(dateString + 'T00:00:00');
    const options = { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' };
    return date.toLocaleDateString('en-US', options);
}

function validatePhoneNumber(phone) {
    const cleaned = phone.replace(/\D/g, '');
    return cleaned.length === 10;
}

function formatPhoneNumber(phone) {
    const cleaned = phone.replace(/\D/g, '');
    const match = cleaned.match(/^(\d{3})(\d{3})(\d{4})$/);
    if (match) {
        return '(' + match[1] + ') ' + match[2] + '-' + match[3];
    }
    return phone;
}

function isDuplicatePlayer(firstName, lastName, phone) {
    const normalizedName = (firstName + ' ' + lastName).toLowerCase().trim();
    const normalizedPhone = phone.replace(/\D/g, '');
    
    const inPlayers = players.find(p => 
        (p.firstName + ' ' + p.lastName).toLowerCase().trim() === normalizedName ||
        p.phone.replace(/\D/g, '') === normalizedPhone
    );
    
    const inWaitlist = waitlist.find(p => 
        (p.firstName + ' ' + p.lastName).toLowerCase().trim() === normalizedName ||
        p.phone.replace(/\D/g, '') === normalizedPhone
    );
    
    return inPlayers || inWaitlist;
}

function getPlayerCount() {
    return players.filter(p => !p.isGoalie).length;
}

function getGoalieCount() {
    return players.filter(p => p.isGoalie).length;
}

function isGoalieSpotsAvailable() {
    return getGoalieCount() < MAX_GOALIES;
}

function generateFairTeams() {
    const goalies = players.filter(p => p.isGoalie);
    const skaters = players.filter(p => !p.isGoalie);
    
    skaters.sort((a, b) => {
        const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
        const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
        return nameA.localeCompare(nameB);
    });
    
    goalies.sort((a, b) => {
        const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
        const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
        return nameA.localeCompare(nameB);
    });
    
    let whiteTeam = [];
    let darkTeam = [];
    let whiteRating = 0;
    let darkRating = 0;
    
    if (goalies.length >= 2) {
        whiteTeam.push({ ...goalies[0], team: 'White' });
        darkTeam.push({ ...goalies[1], team: 'Dark' });
        whiteRating += parseInt(goalies[0].rating) || 0;
        darkRating += parseInt(goalies[1].rating) || 0;
    } else if (goalies.length === 1) {
        whiteTeam.push({ ...goalies[0], team: 'White' });
        whiteRating += parseInt(goalies[0].rating) || 0;
    }
    
    let whiteTurn = whiteTeam.length <= darkTeam.length;
    
    for (let i = 0; i < skaters.length; i++) {
        const skater = skaters[i];
        
        if (whiteTurn) {
            whiteTeam.push({ ...skater, team: 'White' });
            whiteRating += parseInt(skater.rating) || 0;
        } else {
            darkTeam.push({ ...skater, team: 'Dark' });
            darkRating += parseInt(skater.rating) || 0;
        }
        
        whiteTurn = !whiteTurn;
        
        if (Math.abs(whiteTeam.length - darkTeam.length) > 1) {
            whiteTurn = whiteTeam.length < darkTeam.length;
        }
    }
    
    const sortTeam = (team) => {
        return team.sort((a, b) => {
            if (a.isGoalie && !b.isGoalie) return -1;
            if (!a.isGoalie && b.isGoalie) return 1;
            const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
            const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
            return nameA.localeCompare(nameB);
        });
    };
    
    whiteTeam = sortTeam(whiteTeam);
    darkTeam = sortTeam(darkTeam);
    
    players = [...whiteTeam, ...darkTeam];
    
    return { whiteTeam, darkTeam, whiteRating, darkRating };
}

async function saveWeekHistory(year, weekNumber, whiteTeam, darkTeam) {
    try {
        const whiteAvg = (whiteTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0) / whiteTeam.length).toFixed(1);
        const darkAvg = (darkTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0) / darkTeam.length).toFixed(1);
        
        await pool.query(
            `INSERT INTO history (week_number, year, release_date, game_location, game_time, game_date, white_team, dark_team, white_avg, dark_avg)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
                weekNumber,
                year,
                new Date(),
                gameLocation,
                gameTime,
                gameDate,
                JSON.stringify(whiteTeam),
                JSON.stringify(darkTeam),
                whiteAvg,
                darkAvg
            ]
        );
    } catch (err) {
        console.error('Error saving week history:', err);
    }
}

async function getHistoryList() {
    try {
        const res = await pool.query(
            'SELECT week_number, year, release_date FROM history ORDER BY year DESC, week_number DESC'
        );
        return res.rows.map(row => ({
            weekNumber: row.week_number,
            year: row.year,
            created: row.release_date
        }));
    } catch (err) {
        console.error('Error reading history:', err);
        return [];
    }
}

async function getWeekHistory(year, weekNumber) {
    try {
        const res = await pool.query(
            'SELECT * FROM history WHERE year = $1 AND week_number = $2',
            [year, weekNumber]
        );
        
        if (res.rows.length > 0) {
            const row = res.rows[0];
            return {
                weekNumber: row.week_number,
                year: row.year,
                releaseDate: row.release_date,
                gameLocation: row.game_location,
                gameTime: row.game_time,
                gameDate: row.game_date,
                whiteTeam: row.white_team,
                darkTeam: row.dark_team,
                whiteTeamAvg: row.white_avg,
                darkTeamAvg: row.dark_avg
            };
        }
        return null;
    } catch (err) {
        console.error('Error reading week history:', err);
        return null;
    }
}

async function deleteWeekHistory(year, weekNumber) {
    try {
        const res = await pool.query(
            'DELETE FROM history WHERE year = $1 AND week_number = $2 RETURNING *',
            [year, weekNumber]
        );
        
        if (res.rowCount > 0) {
            return { success: true, deleted: res.rowCount };
        } else {
            return { success: false, error: "Week not found in history" };
        }
    } catch (err) {
        console.error('Error deleting history:', err);
        return { success: false, error: err.message };
    }
}

// --- ROUTES ---

// Debug routes
app.get('/api/debug-time', (req, res) => {
    const now = new Date();
    const etTime = getCurrentETTime();
    const shouldLock = shouldBeLocked();
    
    res.json({
        systemTime: now.toISOString(),
        etTime: etTime.toISOString(),
        etDay: etTime.getDay(),
        etHour: etTime.getHours(),
        shouldBeLocked: shouldLock,
        "schedule": "Locked: Sun 5pm - Wed 5pm, Reset: Sun 11:58pm",
        requirePlayerCode: requirePlayerCode,
        manualOverride: manualOverride,
        rosterReleased: rosterReleased
    });
});

app.get('/api/force-check', (req, res) => {
    const result = checkAutoLock();
    res.json({ 
        message: 'Lock check forced',
        ...result,
        timestamp: new Date().toISOString()
    });
});

// HTML Page Routes - Fixed to use root-relative paths
app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/waitlist', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'waitlist.html'));
});

app.get('/roster', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'roster.html'));
});

app.get('/history', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

app.get('/rules', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'rules.html'));
});

// Root route must be last among HTML routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- PUBLIC API ---
app.get('/api/status', (req, res) => {
    const lockStatus = checkAutoLock();
    const etTime = getCurrentETTime();
    const { week, year } = getWeekNumber(etTime);
    
    const playerCount = getPlayerCount();
    const goalieCount = getGoalieCount();
    
    res.json({
        playerSpotsRemaining: playerSpots > 0 ? playerSpots : 0,
        goalieCount: goalieCount,
        goalieSpotsAvailable: MAX_GOALIES - goalieCount,
        maxGoalies: MAX_GOALIES,
        totalPlayers: players.length,
        isFull: playerSpots === 0,
        waitlistCount: waitlist.length,
        requireCode: requirePlayerCode,
        isLockedWindow: lockStatus.isLockedWindow,
        manualOverride: lockStatus.manualOverride,
        manualOverrideState: lockStatus.manualOverrideState,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate),
        rosterReleased: rosterReleased,
        rosterReleaseTime: currentWeekData.rosterReleaseTime,
        currentWeek: week,
        currentYear: year,
        rules: GAME_RULES,
        players: players.map(p => ({
            id: p.id,
            firstName: p.firstName,
            lastName: p.lastName,
            isGoalie: p.isGoalie,
            rating: p.rating,
            canCancel: !p.isGoalie && !(p.firstName.toLowerCase() === 'phan' && p.lastName.toLowerCase() === 'ly')
        }))
    });
});

app.get('/api/waitlist', (req, res) => {
    const waitlistNames = waitlist.map((p, index) => ({
        position: index + 1,
        fullName: `${p.firstName} ${p.lastName}`,
        isGoalie: p.isGoalie
    }));
    
    res.json({
        waitlist: waitlistNames,
        totalWaitlist: waitlist.length,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate)
    });
});

app.get('/api/roster', (req, res) => {
    if (!rosterReleased) {
        return res.json({
            released: false,
            message: "Roster has not been released yet",
            releaseTime: "Teams released every Sunday at 5:00 PM ET"
        });
    }
    
    const sortPlayers = (a, b) => {
        if (a.isGoalie && !b.isGoalie) return -1;
        if (!a.isGoalie && b.isGoalie) return 1;
        const nameA = (a.firstName + ' ' + a.lastName).toLowerCase();
        const nameB = (b.firstName + ' ' + b.lastName).toLowerCase();
        return nameA.localeCompare(nameB);
    };
    
    const whiteTeam = players.filter(p => p.team === 'White').sort(sortPlayers);
    const darkTeam = players.filter(p => p.team === 'Dark').sort(sortPlayers);
    
    const whiteRating = whiteTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0);
    const darkRating = darkTeam.reduce((sum, p) => sum + (parseInt(p.rating) || 0), 0);
    
    res.json({
        released: true,
        whiteTeam,
        darkTeam,
        whiteRating: (whiteRating / whiteTeam.length).toFixed(1),
        darkRating: (darkRating / darkTeam.length).toFixed(1),
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate),
        weekNumber: currentWeekData.weekNumber,
        year: currentWeekData.year
    });
});

// History API
app.get('/api/history', async (req, res) => {
    const history = await getHistoryList();
    res.json({ history });
});

app.get('/api/history/:year/:week', async (req, res) => {
    const { year, week } = req.params;
    const weekData = await getWeekHistory(parseInt(year), parseInt(week));
    
    if (weekData) {
        res.json(weekData);
    } else {
        res.status(404).json({ error: "Week not found" });
    }
});

app.delete('/api/admin/history/:year/:week', async (req, res) => {
    const { password, sessionToken } = req.body;
    
    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    const { year, week } = req.params;
    const yearNum = parseInt(year);
    const weekNum = parseInt(week);
    
    if (isNaN(yearNum) || isNaN(weekNum)) {
        return res.status(400).json({ error: "Invalid year or week number" });
    }
    
    const result = await deleteWeekHistory(yearNum, weekNum);
    
    if (result.success) {
        res.json({ 
            success: true, 
            message: `Week ${weekNum}, ${yearNum} deleted from history`,
            deleted: result.deleted
        });
    } else {
        res.status(404).json({ error: result.error });
    }
});

app.post('/api/verify-code', (req, res) => {
    checkAutoLock();
    
    const { code } = req.body;
    
    if (!requirePlayerCode) {
        return res.json({ valid: true, message: "Signup is open to all" });
    }
    
    if (code === playerSignupCode) {
        res.json({ valid: true });
    } else {
        res.status(401).json({ valid: false, error: "Invalid code" });
    }
});

app.post('/api/register-init', async (req, res) => {
    checkAutoLock();

    const { firstName, lastName, phone, paymentMethod, rating, signupCode } = req.body;

    if (!firstName || !lastName || !phone || !paymentMethod || !rating) {
        return res.status(400).json({ error: "All fields are required." });
    }

    if (isDuplicatePlayer(firstName, lastName, phone)) {
        return res.status(400).json({ error: "A player with this name or phone number is already registered." });
    }

    if (!validatePhoneNumber(phone)) {
        return res.status(400).json({ error: "Please enter a valid 10-digit phone number." });
    }

    const ratingNum = parseInt(rating);
    if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 10) {
        return res.status(400).json({ error: "Rating must be a number between 1 and 10." });
    }

    if (playerSpots <= 0) {
        const formattedPhone = formatPhoneNumber(phone);
        const waitlistPlayer = {
            id: Date.now(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: formattedPhone,
            paymentMethod,
            rating: ratingNum,
            isGoalie: false,
            joinedAt: new Date()
        };

        try {
            await pool.query(
                `INSERT INTO waitlist (id, first_name, last_name, phone, payment_method, rating, is_goalie)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [waitlistPlayer.id, waitlistPlayer.firstName, waitlistPlayer.lastName, 
                 waitlistPlayer.phone, waitlistPlayer.paymentMethod, waitlistPlayer.rating, false]
            );
            waitlist.push(waitlistPlayer);
        } catch (err) {
            console.error('Error adding to waitlist:', err);
        }

        return res.json({
            success: true,
            inWaitlist: true,
            waitlistPosition: waitlist.length,
            message: "Game is full. You have been added to the waitlist."
        });
    }

    if (requirePlayerCode) {
        if (signupCode !== playerSignupCode) {
            return res.status(401).json({ error: "Invalid or missing signup code" });
        }
    }

    res.json({ 
        success: true, 
        proceedToRules: true,
        isGoalie: false,
        tempData: {
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: formatPhoneNumber(phone),
            paymentMethod,
            rating: ratingNum,
            isGoalie: false
        }
    });
});

app.post('/api/register-final', async (req, res) => {
    const { tempData, rulesAgreed } = req.body;
    
    if (!rulesAgreed) {
        return res.status(400).json({ error: "You must agree to the rules to register." });
    }
    
    if (!tempData || !tempData.firstName) {
        return res.status(400).json({ error: "Registration data missing." });
    }
    
    if (isDuplicatePlayer(tempData.firstName, tempData.lastName, tempData.phone)) {
        return res.status(400).json({ error: "A player with this name or phone number is already registered." });
    }
    
    const newPlayer = {
        id: Date.now(),
        firstName: tempData.firstName,
        lastName: tempData.lastName,
        phone: tempData.phone,
        paymentMethod: tempData.paymentMethod,
        paid: false,
        paidAmount: null,
        rating: parseInt(tempData.rating) || 5,
        isGoalie: false,
        team: null,
        registeredAt: new Date().toISOString(),
        rulesAgreed: true
    };

    try {
        await pool.query(
            `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team, rules_agreed)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
             newPlayer.paymentMethod, newPlayer.paid, newPlayer.paidAmount, newPlayer.rating, false, null, true]
        );
        players.push(newPlayer);
        playerSpots--;
        await saveData();
    } catch (err) {
        console.error('Error saving player:', err);
        return res.status(500).json({ error: "Database error" });
    }

    res.json({ 
        success: true, 
        inWaitlist: false,
        message: `You're registered! E-Transfer payment must be received before stepping on the ice.`,
        paymentDeadline: "Before stepping on the ice",
        rosterReleaseTime: "Teams released after admin generates roster",
        isGoalie: false
    });
});

// CANCEL REGISTRATION ENDPOINT
app.post('/api/cancel-registration', async (req, res) => {
    const { playerId, phone } = req.body;
    
    if (!playerId || !phone) {
        return res.status(400).json({ error: "Player ID and phone number are required." });
    }
    
    const idToRemove = parseInt(playerId);
    if (isNaN(idToRemove)) {
        return res.status(400).json({ error: "Invalid player ID." });
    }
    
    const playerIndex = players.findIndex(p => p.id === idToRemove);
    
    if (playerIndex === -1) {
        return res.status(404).json({ error: "Player not found." });
    }
    
    const player = players[playerIndex];
    
    const submittedPhone = phone.replace(/\D/g, '');
    const storedPhone = player.phone.replace(/\D/g, '');
    
    if (submittedPhone !== storedPhone) {
        return res.status(401).json({ error: "Phone number does not match registration." });
    }
    
    if (player.isGoalie) {
        return res.status(403).json({ error: "Goalies cannot cancel online. Please contact admin." });
    }
    
    if (player.firstName.toLowerCase() === 'phan' && player.lastName.toLowerCase() === 'ly') {
        return res.status(403).json({ error: "This player cannot cancel online. Please contact admin." });
    }
    
    if (rosterReleased) {
        return res.status(403).json({ error: "Cannot cancel after roster has been released." });
    }
    
    try {
        await pool.query('DELETE FROM players WHERE id = $1', [player.id]);
    } catch (err) {
        console.error('Error removing from database:', err);
    }
    
    players.splice(playerIndex, 1);
    playerSpots++;
    
    let promotedPlayer = null;
    
    if (waitlist.length > 0) {
        const waitlistPlayer = waitlist.shift();
        
        promotedPlayer = {
            id: waitlistPlayer.id,
            firstName: waitlistPlayer.firstName,
            lastName: waitlistPlayer.lastName,
            phone: waitlistPlayer.phone,
            paymentMethod: waitlistPlayer.paymentMethod,
            paid: false,
            paidAmount: null,
            rating: parseInt(waitlistPlayer.rating) || 5,
            isGoalie: waitlistPlayer.isGoalie,
            team: null,
            registeredAt: new Date().toISOString(),
            rulesAgreed: true
        };
        
        players.push(promotedPlayer);
        playerSpots--;
        
        try {
            await pool.query('DELETE FROM waitlist WHERE id = $1', [waitlistPlayer.id]);
            await pool.query(
                `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team, rules_agreed)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
                [promotedPlayer.id, promotedPlayer.firstName, promotedPlayer.lastName, promotedPlayer.phone,
                 promotedPlayer.paymentMethod, promotedPlayer.paid, promotedPlayer.paidAmount, promotedPlayer.rating, promotedPlayer.isGoalie, null, true]
            );
        } catch (err) {
            console.error('Error promoting waitlist player:', err);
        }
    }
    
    await saveData();
    
    res.json({
        success: true,
        message: "Registration cancelled successfully.",
        promotedPlayer: promotedPlayer ? {
            firstName: promotedPlayer.firstName,
            lastName: promotedPlayer.lastName
        } : null,
        spotsAvailable: playerSpots
    });
});

// --- ADMIN API ---
app.post('/api/admin/check-session', (req, res) => {
    const { sessionToken } = req.body;
    if (adminSessions[sessionToken]) {
        res.json({ loggedIn: true });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/admin/login', (req, res) => {
    const { password } = req.body;
    if (password === ADMIN_PASSWORD) {
        const sessionToken = Date.now().toString() + Math.random().toString();
        adminSessions[sessionToken] = true;
        res.json({ success: true, sessionToken: sessionToken });
    } else {
        res.status(401).json({ success: false });
    }
});

app.post('/api/admin/players', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    const playerCount = getPlayerCount();
    const goalieCount = getGoalieCount();
    
    // Calculate total paid amount
    const totalPaid = players.reduce((sum, p) => {
        if (p.paidAmount && !isNaN(parseFloat(p.paidAmount))) {
            return sum + parseFloat(p.paidAmount);
        }
        return sum;
    }, 0);
    
    res.json({ 
        playerSpots, 
        playerCount,
        goalieCount,
        maxGoalies: MAX_GOALIES,
        totalPlayers: players.length,
        totalPaid: totalPaid.toFixed(2),
        players, 
        waitlist, 
        location: gameLocation, 
        time: gameTime,
        date: gameDate,
        rosterReleased, 
        currentWeekData, 
        playerSignupCode, 
        requirePlayerCode 
    });
});

app.post('/api/admin/settings', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    const lockStatus = checkAutoLock();
    
    res.json({
        code: playerSignupCode,
        requireCode: requirePlayerCode,
        isLockedWindow: lockStatus.isLockedWindow,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        rosterReleased
    });
});

app.post('/api/admin/update-details', (req, res) => {
    const { password, sessionToken, location, time, date } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    if (location && location.trim().length > 0) {
        gameLocation = location.trim();
    }
    if (time && time.trim().length > 0) {
        gameTime = time.trim();
    }
    if (date && date.trim().length > 0) {
        gameDate = date.trim();
    }
    
    saveData();
    
    res.json({ 
        success: true, 
        location: gameLocation,
        time: gameTime,
        date: gameDate,
        formattedDate: formatGameDate(gameDate)
    });
});

app.post('/api/admin/update-code', (req, res) => {
    const { password, sessionToken, newCode } = req.body;
    
    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized - invalid session" });
    }
    
    if (!newCode || !/^\d{4}$/.test(newCode)) {
        return res.status(400).json({ error: "Code must be exactly 4 digits" });
    }
    
    playerSignupCode = newCode;
    saveData();
    
    res.json({ 
        success: true, 
        code: playerSignupCode, 
        requireCode: requirePlayerCode 
    });
});

app.post('/api/admin/toggle-code', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    const newRequireCode = !requirePlayerCode;
    
    requirePlayerCode = newRequireCode;
    manualOverride = true;
    manualOverrideState = newRequireCode ? 'locked' : 'open';
    
    saveData();
    
    res.json({ 
        success: true, 
        requireCode: requirePlayerCode,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        code: playerSignupCode 
    });
});

app.post('/api/admin/reset-schedule', (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    manualOverride = false;
    manualOverrideState = null;
    
    const result = checkAutoLock();
    
    res.json({ 
        success: true, 
        requireCode: requirePlayerCode,
        manualOverride: manualOverride,
        manualOverrideState: manualOverrideState,
        message: "Auto-schedule restored"
    });
});

app.post('/api/admin/promote-waitlist', async (req, res) => {
    const { password, sessionToken, waitlistId } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const index = waitlist.findIndex(p => p.id === waitlistId);
    if (index === -1) {
        return res.status(404).json({ error: "Player not found in waitlist" });
    }

    const player = waitlist.splice(index, 1)[0];
    
    const newPlayer = {
        id: player.id,
        firstName: player.firstName,
        lastName: player.lastName,
        phone: player.phone,
        paymentMethod: player.paymentMethod,
        paid: false,
        paidAmount: null,
        rating: parseInt(player.rating) || 5,
        isGoalie: player.isGoalie,
        team: null
    };
    
    try {
        await pool.query(
            `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
             newPlayer.paymentMethod, newPlayer.paid, newPlayer.paidAmount, newPlayer.rating, newPlayer.isGoalie, null]
        );
        players.push(newPlayer);
        
        if (!player.isGoalie && playerSpots > 0) {
            playerSpots--;
        }
        
        await saveData();
    } catch (err) {
        console.error('Error promoting player:', err);
        return res.status(500).json({ error: "Database error" });
    }

    res.json({ 
        success: true, 
        player: newPlayer,
        spots: playerSpots,
        override: playerSpots <= 0 && !player.isGoalie
    });
});

app.post('/api/admin/remove-waitlist', async (req, res) => {
    const { password, sessionToken, waitlistId } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const index = waitlist.findIndex(p => p.id === waitlistId);
    if (index === -1) {
        return res.status(404).json({ error: "Player not found in waitlist" });
    }

    const player = waitlist.splice(index, 1)[0];
    
    try {
        await pool.query('DELETE FROM waitlist WHERE id = $1', [player.id]);
    } catch (err) {
        console.error('Error removing from waitlist:', err);
    }
    
    saveData();
    res.json({ success: true });
});

app.post('/api/admin/add-player', async (req, res) => {
    const { password, sessionToken, firstName, lastName, phone, paymentMethod, rating, isGoalie, toWaitlist } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    if (!firstName || !lastName || !phone || !rating) {
        return res.status(400).json({ error: "First name, last name, phone, and rating required" });
    }

    if (!validatePhoneNumber(phone)) {
        return res.status(400).json({ error: "Invalid phone number format" });
    }

    const formattedPhone = formatPhoneNumber(phone);
    const ratingNum = parseInt(rating) || 5;
    const isGoalieBool = isGoalie || false;

    if (toWaitlist) {
        const waitlistPlayer = {
            id: Date.now(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: formattedPhone,
            paymentMethod: paymentMethod || 'Cash',
            rating: ratingNum,
            isGoalie: isGoalieBool,
            joinedAt: new Date()
        };
        
        try {
            await pool.query(
                `INSERT INTO waitlist (id, first_name, last_name, phone, payment_method, rating, is_goalie)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
                [waitlistPlayer.id, waitlistPlayer.firstName, waitlistPlayer.lastName,
                 waitlistPlayer.phone, waitlistPlayer.paymentMethod, waitlistPlayer.rating, isGoalieBool]
            );
            waitlist.push(waitlistPlayer);
        } catch (err) {
            console.error('Error adding to waitlist:', err);
            return res.status(500).json({ error: "Database error" });
        }
        
        saveData();
        res.json({ success: true, player: waitlistPlayer, inWaitlist: true });
    } else {
        if (isGoalieBool && !isGoalieSpotsAvailable()) {
            return res.status(400).json({ error: "Goalie spots are full (maximum 2)." });
        }
        
        const newPlayer = {
            id: Date.now(),
            firstName: firstName.trim(),
            lastName: lastName.trim(),
            phone: formattedPhone,
            paymentMethod: paymentMethod || 'Cash',
            paid: isGoalieBool ? true : false,
            paidAmount: isGoalieBool ? 0 : null,
            rating: ratingNum,
            isGoalie: isGoalieBool,
            team: null
        };
        
        try {
            await pool.query(
                `INSERT INTO players (id, first_name, last_name, phone, payment_method, paid, paid_amount, rating, is_goalie, team)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
                [newPlayer.id, newPlayer.firstName, newPlayer.lastName, newPlayer.phone,
                 newPlayer.paymentMethod, newPlayer.paid, newPlayer.paidAmount, newPlayer.rating, isGoalieBool, null]
            );
            players.push(newPlayer);
            
            if (!isGoalieBool && playerSpots > 0) {
                playerSpots--;
            }
            
            await saveData();
        } catch (err) {
            console.error('Error adding player:', err);
            return res.status(500).json({ error: "Database error" });
        }
        
        res.json({ success: true, player: newPlayer, inWaitlist: false });
    }
});

// ADMIN REMOVE PLAYER - WORKS ON ANY PLAYER AT ANY TIME (NO RESTRICTIONS)
app.post('/api/admin/remove-player', async (req, res) => {
    const { password, sessionToken, playerId } = req.body;
    
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const idToRemove = parseInt(playerId);
    if (isNaN(idToRemove)) {
        return res.status(400).json({ error: "Invalid player ID" });
    }

    const index = players.findIndex(p => p.id === idToRemove);
    
    if (index === -1) {
        return res.status(404).json({ error: "Player not found" });
    }

    const wasGoalie = players[index].isGoalie;
    const player = players.splice(index, 1)[0];
    
    try {
        await pool.query('DELETE FROM players WHERE id = $1', [player.id]);
        
        if (!wasGoalie) {
            playerSpots++;
        }
        
        await saveData();
    } catch (err) {
        console.error('Error removing player:', err);
        return res.status(500).json({ error: "Database error" });
    }

    // Return the removed player info for confirmation message
    res.json({ 
        success: true, 
        spots: playerSpots, 
        removedPlayer: player 
    });
});

app.post('/api/admin/update-spots', (req, res) => {
    const { password, sessionToken, newSpots } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    const spotCount = parseInt(newSpots);
    if (isNaN(spotCount) || spotCount < 0 || spotCount > 30) {
        return res.status(400).json({ error: "Invalid spot count (0-30 allowed)" });
    }
    
    playerSpots = spotCount;
    saveData();
    res.json({ success: true, spots: playerSpots });
});

// Update paid amount endpoint
app.post('/api/admin/update-paid-amount', async (req, res) => {
    const { password, sessionToken, playerId, amount } = req.body;
    
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const player = players.find(p => p.id === playerId);
    if (!player) {
        return res.status(404).json({ error: "Player not found" });
    }

    // Parse amount - allow empty/null for unpaid
    let paidAmount = null;
    let paid = false;
    
    if (amount !== '' && amount !== null && amount !== undefined) {
        const parsed = parseFloat(amount);
        if (!isNaN(parsed) && parsed >= 0) {
            paidAmount = parsed;
            paid = parsed > 0;
        }
    }

    player.paidAmount = paidAmount;
    player.paid = paid;

    try {
        await pool.query('UPDATE players SET paid_amount = $1, paid = $2 WHERE id = $3', 
            [paidAmount, paid, player.id]);
        saveData();
        
        // Calculate new total
        const totalPaid = players.reduce((sum, p) => {
            if (p.paidAmount && !isNaN(parseFloat(p.paidAmount))) {
                return sum + parseFloat(p.paidAmount);
            }
            return sum;
        }, 0);
        
        res.json({ success: true, player, totalPaid: totalPaid.toFixed(2) });
    } catch (err) {
        console.error('Error updating paid amount:', err);
        res.status(500).json({ error: "Database error" });
    }
});

// FIX: Store old rating before updating
app.post('/api/admin/update-rating', async (req, res) => {
    const { password, sessionToken, playerId, newRating } = req.body;

    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }

    const ratingNum = parseInt(newRating);
    if (isNaN(ratingNum) || ratingNum < 1 || ratingNum > 10) {
        return res.status(400).json({ error: "Rating must be a number between 1 and 10" });
    }

    const player = players.find(p => p.id === parseInt(playerId));
    if (!player) {
        return res.status(404).json({ error: "Player not found" });
    }

    const oldRating = player.rating; // Store old rating before update
    player.rating = ratingNum;

    try {
        await pool.query('UPDATE players SET rating = $1 WHERE id = $2', [ratingNum, player.id]);
        saveData();
        res.json({ success: true, player, oldRating: oldRating, newRating: ratingNum });
    } catch (err) {
        console.error('Error updating rating:', err);
        res.status(500).json({ error: "Database error" });
    }
});

app.post('/api/admin/release-roster', async (req, res) => {
    const { password, sessionToken } = req.body;
    
    if (!adminSessions[sessionToken]) {
        return res.status(401).json({ error: "Unauthorized" });
    }
    
    if (players.length === 0) {
        return res.status(400).json({ error: "No players registered yet" });
    }
    
    try {
        const etTime = getCurrentETTime();
        const { week, year } = getWeekNumber(etTime);
        
        const teams = generateFairTeams();
        
        rosterReleased = true;
        requirePlayerCode = true;
        manualOverride = true;  // Keep locked after manual release
        manualOverrideState = 'locked';  // Force locked state
        
        currentWeekData = {
            weekNumber: week,
            year: year,
            releaseDate: new Date().toISOString(),
            rosterReleaseTime: Date.now(),
            whiteTeam: teams.whiteTeam,
            darkTeam: teams.darkTeam
        };
        
        for (const player of players) {
            await pool.query('UPDATE players SET team = $1 WHERE id = $2', [player.team, player.id]);
        }
        
        await saveWeekHistory(year, week, teams.whiteTeam, teams.darkTeam);
        await saveData();
        
        res.json({ 
            success: true, 
            message: "Roster released successfully. Signup is now LOCKED until Wednesday 5pm.",
            whiteTeam: teams.whiteTeam,
            darkTeam: teams.darkTeam,
            whiteRating: teams.whiteRating.toFixed(1),
            darkRating: teams.darkRating.toFixed(1),
            signupLocked: true,
            rosterReleased: true
        });
    } catch (error) {
        console.error('Release roster error:', error);
        res.status(500).json({ error: "Server error: " + error.message });
    }
});

app.post('/api/admin/manual-reset', async (req, res) => {
    const { password, sessionToken } = req.body;
    if (!adminSessions[sessionToken] && password !== ADMIN_PASSWORD) {
        return res.status(401).send("Unauthorized");
    }
    
    if (rosterReleased && currentWeekData.weekNumber) {
        await saveWeekHistory(
            currentWeekData.year,
            currentWeekData.weekNumber,
            currentWeekData.whiteTeam,
            currentWeekData.darkTeam
        );
    }
    
    const etTime = getCurrentETTime();
    const { week, year } = getWeekNumber(etTime);
    
    playerSpots = 20;
    players = [];
    waitlist = [];
    rosterReleased = false;
    lastResetWeek = week;
    gameDate = calculateNextSunday();
    
    currentWeekData = {
        weekNumber: week,
        year: year,
        releaseDate: null,
        whiteTeam: [],
        darkTeam: []
    };
    
    manualOverride = false;
    manualOverrideState = null;
    requirePlayerCode = true;
    
    // Code stays as 7666 - no auto-generation
    
    try {
        await pool.query('DELETE FROM players');
        await pool.query('DELETE FROM waitlist');
        
        // Auto-add predefined players after reset
        await addAutoPlayers();
        
        await saveData();
    } catch (err) {
        console.error('Error resetting:', err);
    }
    
    res.json({ success: true, message: "Manual reset completed", code: playerSignupCode });
});

// 404 handler - MUST be last
app.use((req, res) => {
    res.status(404).json({ error: "Cannot GET " + req.path });
});

// Initialize and start
initDatabase().then(() => {
    checkAutoLock();
    checkWeeklyReset();
    
    cron.schedule('* * * * *', () => {
        autoReleaseRoster();
    }, {
        timezone: 'America/New_York'
    });
    
    app.listen(PORT, () => {
        console.log(`Phan's Sunday Hockey server running on port ${PORT}`);
        console.log(`Location: ${gameLocation}`);
        console.log(`Time: ${gameTime}`);
        console.log(`Date: ${gameDate}`);
        console.log(`Current signup code: ${playerSignupCode}`);
        console.log(`Current players registered: ${players.length}`);
    });
}).catch(err => {
    console.error('Failed to initialize database, starting with file fallback:', err);
    loadDataFromFile();
    
    checkAutoLock();
    checkWeeklyReset();
    
    cron.schedule('* * * * *', () => {
        autoReleaseRoster();
    }, {
        timezone: 'America/New_York'
    });
    
    app.listen(PORT, () => {
        console.log(`Server running on port ${PORT} (file fallback mode)`);
    });
});