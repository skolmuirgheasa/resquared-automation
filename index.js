import express from 'express';
import dotenv from 'dotenv';
import { Hyperbrowser } from "@hyperbrowser/sdk";

// Configure environment variables
dotenv.config();

// Setup Express
const app = express();
const port = process.env.PORT || 3000;

// Initialize Hyperbrowser client
const hbClient = new Hyperbrowser({
  apiKey: process.env.HYPERBROWSER_API_KEY
});

// Configure Express middleware
app.use(express.json());

// Add a logging utility
const logStep = (message, data = {}) => {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log('\n' + '='.repeat(80));
  console.log(logMessage);
  if (Object.keys(data).length > 0) {
    console.log('-'.repeat(40));
    console.log(JSON.stringify(data, null, 2));
  }
  console.log('='.repeat(80) + '\n');
};

// MAIN ENDPOINT
app.post('/run-campaign', async (req, res) => {
  const { prompt, saasUrl, saasUsername, saasPassword } = req.body;
  let jobId = null;
  
  if (!prompt || !saasUrl || !saasUsername || !saasPassword) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }
  
  // Log everything except password
  logStep(`Starting campaign`, { 
    prompt, 
    saasUrl, 
    username: saasUsername,
    passwordLength: saasPassword.length // Log password length for debugging
  });
  
  try {
    const searchTerm = prompt.replace(/make a list of/i, '').replace(/places/i, '').trim();
    logStep(`Extracted search term: "${searchTerm}"`);
    
    // Simplified task description with explicit password
    const taskDescription = `
      Task: Create a list of "${searchTerm}" businesses in Resquared
      
      Steps:
      1. Navigate to ${saasUrl}
      2. Log in:
         - Enter "${saasUsername}" in the email field (use input[type="email"])
         - Enter "${saasPassword}" in the password field (use input[type="password"])
         - Click the login button (use button[type="submit"])
         - Wait for dashboard to load
      3. After login:
         - Click "Search" in the navigation
         - Wait for search page
      4. Perform search:
         - Click to expand search section if needed
         - Type "${searchTerm}" in search field
         - Press Enter
         - Wait for results
      5. Handle results:
         - Click checkbox to select all
         - Click "Save to List"
         - Confirm if needed
      
      Important:
      - Handle any popups or tutorials that appear
      - Make sure search section is expanded before searching
      - Wait for page loads between actions
      
      Exact selectors to use:
      - Email field: input[type="email"]
      - Password field: input[type="password"]
      - Login button: button[type="submit"]
      - Search nav: text="Search"
      - Search input: input[placeholder="Search"]
      - Save button: text="Save to List"
      
      Login credentials (copy exactly):
      Email: ${saasUsername}
      Password: ${saasPassword}
    `;

    logStep('Starting browser session');

    // Start the browser-use task with streamlined configuration
    const result = await hbClient.beta.agents.browserUse.startAndWait({
      task: taskDescription,
      validateOutput: true,
      useVision: true,
      useVisionForPlanner: true,
      maxActionsPerStep: 3,
      maxSteps: 20,
      logLevel: 'info',
      sessionOptions: {
        acceptCookies: true,
        solveRecaptchas: true,
        viewport: { width: 1280, height: 720 },
        navigationTimeout: 30000,
        waitForTimeout: 5000,
        cleanupOnProcessExit: true,
        cleanupOnError: true
      }
    });

    jobId = result.jobId;
    logStep('Received job ID', { jobId });

    // Check for partial completion and specific error messages
    if (result.status === 'completed') {
      const finalResult = result.data?.finalResult?.toLowerCase() || '';
      
      if (finalResult.includes('unable to log in') || 
          finalResult.includes('login failed') || 
          finalResult.includes('password')) {
        throw new Error('Failed to log in - password issue detected');
      }
      
      if (finalResult.includes('unable to complete')) {
        throw new Error('Task partially completed but failed to finish all steps');
      }
      
      logStep('Campaign completed successfully', {
        steps: result.data.steps.length,
        finalResult: result.data.finalResult
      });
      
      res.json({
        success: true,
        message: 'Campaign completed successfully',
        details: result.data.steps
      });
    } else if (result.error) {
      throw new Error(result.error);
    } else {
      throw new Error('Task did not complete successfully');
    }
  } catch (error) {
    logStep('Error in campaign', {
      error: error.message,
      jobId,
      passwordLength: saasPassword.length // Log password length again in error
    });
    
    if (jobId) {
      try {
        await hbClient.beta.agents.browserUse.stop(jobId);
        logStep('Stopped browser session', { jobId });
      } catch (cleanupError) {
        logStep('Error stopping browser session', {
          jobId,
          error: cleanupError.message
        });
      }
    }
    
    return res.status(500).json({
      success: false,
      error: error.message || 'Error starting campaign'
    });
  }
});

// Update cleanup handler with logging
process.on('SIGINT', async () => {
  logStep('Received SIGINT. Cleaning up...');
  try {
    const sessions = await hbClient.beta.agents.browserUse.list();
    for (const session of sessions) {
      if (session.status === 'running') {
        await hbClient.beta.agents.browserUse.stop(session.jobId);
        logStep('Stopped session', { jobId: session.jobId });
      }
    }
  } catch (error) {
    logStep('Error during cleanup', { error: error.message });
  }
  process.exit(0);
});

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});