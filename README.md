# Discord Slot Bot

A complete Discord.js v14 bot for managing customer slot channels and ping redemptions (@here and @everyone).

## Features
- **Slot Code Generation**: Admins can generate codes for 1 Week (`1w`), 1 Month (`1m`), 3 Months (`3m`), or Lifetime (`lifetime`).
- **Dynamic Channel Creation**: Users redeem their code to automatically generate a personal channel named `〢⤷slot-username`.
- **Ping Code Generation**: Admins can generate codes for `@here` or `@everyone` pings.
- **Ping Usage**: Slot owners can use `/use-ping` inside their channel to post announcements with pings.

## File Structure
- `index.js`: Main bot application code.
- `package.json`: Node.js dependencies and run script.
- `.env.example`: Template for environment variables.
- `discloud.config`: Configuration file if uploading to DisCloud.
- `.gitignore`: Prevents sensitive `.env` and `node_modules` from being pushed to GitHub.

## How to Setup & Run

### Local Setup
1. Extract all files into a directory.
2. Create a `.env` file based on `.env.example`:
   ```env
   DISCORD_TOKEN=your_actual_bot_token_here
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Start the bot:
   ```bash
   npm start
   ```

### Free Hosting Options
- **Render.com**: Push this repo to GitHub and deploy as a Background Worker or Web Service (Free tier available, no credit card required).
- **DisCloud**: Upload this zip directly or connect via GitHub using the included `discloud.config`.
