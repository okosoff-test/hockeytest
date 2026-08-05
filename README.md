# Phan's Player Ratings

Standalone temporary peer-rating site. It does not connect to or modify the Friday or Sunday hockey portals.

## Render setup
1. Create a new Neon database and copy its pooled connection string.
2. Create a new Render Web Service from this project.
3. Build command: `npm install`
4. Start command: `npm start`
5. Add environment variables:
   - `DATABASE_URL` = Neon pooled connection string
   - `ADMIN_PASSWORD` = your private admin password
6. Deploy.

Public ratings page: `https://YOUR-SERVICE.onrender.com/`
Admin page: `https://YOUR-SERVICE.onrender.com/admin`

The admin page has the Open/Close Ratings control. Closing ratings preserves all results but blocks public access and submissions.

## Included list
32 unique current Friday/Sunday participants: 28 skaters and four goalies (Craig Scolack, Hao Chau, Mat Carriere, Lilly Isberg).

Photos are resized to 320×320 JPEG and stored in the new Neon database.
