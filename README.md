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

## Admin player deletion
The admin dashboard includes a Delete button for each player. Deleting removes the player from the public list and removes all ratings they gave or received.


## Phone verification
Players select their name and enter the phone number stored in the imported Friday/Sunday portal backups. Phone formatting is ignored. Newly added players must provide a 10-digit phone number. Verified access uses a signed, time-limited player token.

Optional Render environment variable: `PLAYER_TOKEN_SECRET` (recommended). If omitted, `ADMIN_PASSWORD` is used to sign player tokens.


## Partial submissions
Players may leave unfamiliar players blank and submit the ratings they have completed. At least one rating and a photo are required. Blank players are excluded from that rater's results.


## Editing after submission
Players may return while ratings are open, verify by phone, review their prior scores, change or clear ratings, and submit updates again. Submission no longer permanently locks a player's ratings.
