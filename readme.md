# Resquared Automation

An automated tool for creating business lists in Resquared using Hyperbrowser's AI agent system.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create a `.env` file with your credentials:
```bash
HYPERBROWSER_API_KEY=your_key_here
PORT=3000
```

3. Start the server:
```bash
node index.js
```

## API Endpoints

### POST /run-campaign

Creates a list of businesses in Resquared.

Request body:
```json
{
  "prompt": "make a list of pizza places",
  "saasUrl": "https://app.resquared.com",
  "saasUsername": "your_email",
  "saasPassword": "your_password"
}
```

## Environment Variables

- `HYPERBROWSER_API_KEY`: Your Hyperbrowser API key
- `PORT`: Server port (default: 3000)