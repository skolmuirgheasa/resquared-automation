# Setup Instructions for Your Hyperbrowser Automation Tool

This guide will help you set up and run the automation tool on your local computer. Follow these steps carefully.

## Prerequisites (Things You Need to Install)

1. **Node.js** - This is the environment that will run your application
   - Download from: https://nodejs.org/
   - Choose the "LTS" version (Long Term Support)
   - Run the installer with all default options

2. **API Keys** - You'll need these to connect to the services:
   - OpenAI API Key: https://platform.openai.com/api-keys
   - Hyperbrowser API Key: Get this from your Hyperbrowser account

## Step-by-Step Setup

### 1. Create a Folder for Your Project

1. Create a new folder on your computer (name it something like "campaign-automation")
2. Open this folder

### 2. Save the Files

For each file I've provided:
1. Create a new file with the exact name shown
2. Copy and paste the content into the file
3. Save the file in your project folder

Files to create:
- `index.js`
- `package.json`
- `.env` (use the template and fill in your API keys)
- Create a folder named `public` and inside it save `index.html`

### 3. Set Up Your Environment

1. Open the `.env` file
2. Replace `your_openai_api_key_here` with your actual OpenAI API key
3. Replace `your_hyperbrowser_api_key_here` with your actual Hyperbrowser API key
4. Save the file

### 4. Install the Application

1. Open your command prompt or terminal:
   - On Windows: Press Win+R, type `cmd`, and press Enter
   - On Mac: Open Terminal from Applications > Utilities

2. Navigate to your project folder using `cd` command:
   ```
   cd path/to/your/campaign-automation
   ```
   (Replace "path/to/your/campaign-automation" with the actual path)

3. Install the required packages:
   ```
   npm install
   ```
   (This might take a few minutes)

### 5. Run the Application

1. In the same command prompt/terminal, start the application:
   ```
   npm start
   ```

2. You should see a message saying "Server running on port 3000"

3. Open your web browser and go to:
   ```
   http://localhost:3000
   ```

### 6. Using the Tool

1. Fill in the form with:
   - Your SaaS tool URL (where you normally log in)
   - Your SaaS tool username/email
   - Your SaaS tool password
   - Your campaign prompt (e.g., "Run a campaign emailing pizza shops in Chicago")

2. Click "Run Campaign" and wait for the automation to complete

3. You'll see the results displayed on the page

## Troubleshooting

If you encounter any issues:

1. **Application doesn't start**:
   - Check if you installed Node.js correctly
   - Ensure you're in the correct folder when running commands
   - Verify that all files were created correctly

2. **API errors**:
   - Double-check your API keys in the `.env` file
   - Make sure you have an active subscription/credits for both OpenAI and Hyperbrowser

3. **Automation doesn't work**:
   - The automation depends on the structure of your SaaS tool
   - You might need to adjust the selectors in the code for your specific tool
   - Consider hiring a developer for a few hours to customize it for your exact SaaS tool

## Notes on Security

- The application stores your SaaS credentials only in memory and doesn't save them
- However, be cautious about who has access to your computer while the application is running
- Never share your API keys or SaaS credentials with others

## Getting Help

If you need technical assistance:
- Consider hiring a freelance developer for a few hours to customize the solution for your exact needs
- Look for local IT support services that can help with software installation
