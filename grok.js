import express from 'express';
import OpenAI from 'openai';
import { chromium } from 'playwright-core';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs/promises';
import { createReadStream } from 'fs';
import { randomUUID } from 'crypto';
import fetch from 'node-fetch';
import FormData from 'form-data';

// Configure environment variables
dotenv.config();

// Setup Express
const app = express();
const port = process.env.PORT || 3000;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// Configure Express middleware
app.use(express.json());
app.use(express.static('public'));

// Create screenshots directory if it doesn't exist
try {
  await fs.mkdir('screenshots', { recursive: true });
} catch (err) {
  console.error('Error creating screenshots directory:', err);
}

// Convert ESM __dirname
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Simplify the RESQUARED_CONTEXT to be more flexible
const RESQUARED_CONTEXT = `
You are an expert at navigating Resquared, a platform for finding and contacting local businesses.
You will help automate tasks by providing browser automation instructions.

Your goal is to create a list of businesses based on the user's search term.

IMPORTANT: Always respond with a valid JSON object in the following format:
{
  "action": "click" | "fill" | "press" | "wait",
  "selector": "CSS selector or visible text",
  "value": "text to enter (for fill action)",
  "key": "key to press (for press action)",
  "duration": "time in ms (for wait action)",
  "description": "Human readable description"
}

For selectors, prefer:
1. Simple CSS selectors like 'button', 'input[type="text"]'
2. Text content like 'Search', 'Create List'
3. Attributes like '[placeholder="Search"]'

DO NOT use complex Playwright-specific selectors.
`;

// Add better logging for AI interactions
async function logMessage(message, type) {
  const timestamp = new Date().toISOString();
  const logPrefix = type === 'to-ai' ? '>>> TO AI:' : '<<< FROM AI:';
  
  console.log('\n' + '='.repeat(80));
  console.log(`${logPrefix} [${timestamp}]`);
  console.log('-'.repeat(80));
  console.log(message);
  console.log('='.repeat(80) + '\n');
  
  // Also save to log file
  try {
    await fs.appendFile(
      'ai-interactions.log',
      `\n[${timestamp}] ${logPrefix}\n${message}\n${'='.repeat(40)}\n`
    );
  } catch (err) {
    console.error('Error writing to log file:', err);
  }
}

// Replace the uploadScreenshot function with a more reliable approach
async function uploadScreenshot(filePath) {
  try {
    // Use a more reliable image hosting service - ImgBB with proper form handling
    const form = new FormData();
    const fileBuffer = await fs.readFile(filePath);
    
    form.append('key', process.env.IMGBB_API_KEY);
    form.append('image', fileBuffer.toString('base64'));
    
    const response = await fetch('https://api.imgbb.com/1/upload', {
      method: 'POST',
      body: form
    });
    
    const data = await response.json();
    
    if (data.success) {
      console.log('Screenshot uploaded successfully:', data.data.url);
      return data.data.url;
    } else {
      console.error('Failed to upload screenshot:', data.error?.message || 'Unknown error');
      return null;
    }
  } catch (error) {
    console.error('Error uploading screenshot:', error);
    return null;
  }
}

// Replace the resizing function with a simpler approach
async function uploadScreenshotToOpenAI(filePath) {
  try {
    // Use a smaller screenshot size when taking the screenshot
    // This happens before this function is called
    
    // Read the file in chunks to avoid memory issues
    const fileStream = createReadStream(filePath);
    
    const file = await openai.files.create({
      file: fileStream,
      purpose: "assistants"
    });
    
    console.log(`Screenshot uploaded to OpenAI with file ID: ${file.id}`);
    return file.id;
  } catch (error) {
    console.error("Error uploading screenshot to OpenAI:", error);
    
    // If the file is too large, try uploading to ImgBB instead
    try {
      const imgbbUrl = await uploadScreenshot(filePath);
      if (imgbbUrl) {
        console.log("Fallback to ImgBB successful:", imgbbUrl);
        // Create a text message with the image URL
        return null; // Return null to indicate we need to use the URL approach
      }
    } catch (fallbackError) {
      console.error("Fallback upload also failed:", fallbackError);
    }
    
    throw error;
  }
}

// Fix the showAgentStatus function to handle multiple arguments correctly
async function showAgentStatus(page, message, step) {
  try {
    // Check if the status element already exists
    const elementExists = await page.evaluate(() => {
      return !!document.getElementById('ai-agent-status');
    }).catch(() => false);
    
    if (!elementExists) {
      // Inject the status element if it doesn't exist
      await page.evaluate(() => {
        try {
          const statusDiv = document.createElement('div');
          statusDiv.id = 'ai-agent-status';
          statusDiv.style.cssText = `
            position: fixed;
            bottom: 20px;
            right: 20px;
            background-color: rgba(0, 0, 0, 0.8);
            color: white;
            padding: 10px 15px;
            border-radius: 5px;
            font-family: Arial, sans-serif;
            z-index: 9999;
            box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
            display: flex;
            align-items: center;
            max-width: 300px;
          `;
          
          // Add text container
          const textContainer = document.createElement('div');
          textContainer.innerHTML = `
            <div id="ai-agent-step" style="font-weight: bold; margin-bottom: 5px;"></div>
            <div id="ai-agent-message"></div>
          `;
          
          statusDiv.appendChild(textContainer);
          document.body.appendChild(statusDiv);
        } catch (e) {
          console.error('Error creating status element:', e);
        }
      }).catch(err => console.error('Failed to inject status UI:', err));
    }
    
    // Update the status message - fix the multiple arguments issue by passing an object
    await page.evaluate(({ message, step }) => {
      try {
        const stepEl = document.getElementById('ai-agent-step');
        const messageEl = document.getElementById('ai-agent-message');
        
        if (stepEl && messageEl) {
          stepEl.textContent = `Step ${step}`;
          messageEl.textContent = message;
        }
      } catch (e) {
        console.error('Error updating status:', e);
      }
    }, { message, step }).catch(err => console.error('Failed to update status UI:', err));
    
  } catch (error) {
    console.error('Error showing agent status:', error);
  }
}

// Add a function to hide the status UI when done
async function hideAgentStatus(page) {
  try {
    await page.evaluate(() => {
      try {
        const statusDiv = document.getElementById('ai-agent-status');
        if (statusDiv) {
          statusDiv.remove();
        }
      } catch (e) {
        console.error('Error removing status element:', e);
      }
    }).catch(err => console.error('Failed to hide status UI:', err));
  } catch (error) {
    console.error('Error hiding agent status:', error);
  }
}

// Add a function to get detailed DOM information for the assistant
async function getDetailedDomInfo(page) {
  return await page.evaluate(() => {
    // Get all interactive elements
    const interactiveElements = [];
    
    // Helper function to get visible text
    const getVisibleText = (element) => {
      if (!element) return '';
      return element.innerText || element.textContent || '';
    };
    
    // Helper function to check if element is visible
    const isElementVisible = (element) => {
      if (!element) return false;
      
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }
      
      const rect = element.getBoundingClientRect();
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        rect.top < window.innerHeight &&
        rect.bottom > 0 &&
        rect.left < window.innerWidth &&
        rect.right > 0
      );
    };
    
    // Process buttons and links
    document.querySelectorAll('button, [role="button"], a[href], input[type="submit"], input[type="button"]').forEach(el => {
      if (isElementVisible(el)) {
        interactiveElements.push({
          type: 'button',
          text: getVisibleText(el).trim(),
          id: el.id || '',
          classes: el.className || ''
        });
      }
    });
    
    // Process form inputs
    document.querySelectorAll('input:not([type="submit"]):not([type="button"]), textarea, select').forEach(el => {
      if (isElementVisible(el)) {
        interactiveElements.push({
          type: el.type || 'text',
          placeholder: el.placeholder || '',
          id: el.id || '',
          name: el.name || '',
          classes: el.className || ''
        });
      }
    });
    
    // Process text elements that might be important for context
    document.querySelectorAll('h1, h2, h3, h4, h5, h6, p.title, .header, .heading').forEach(el => {
      if (isElementVisible(el)) {
        const text = getVisibleText(el).trim();
        if (text) {
          interactiveElements.push({
            type: 'text',
            text: text,
            tag: el.tagName.toLowerCase(),
            classes: el.className || ''
          });
        }
      }
    });
    
    // Get page metadata
    const metadata = {
      url: window.location.href,
      title: document.title,
      viewport: {
        width: window.innerWidth,
        height: window.innerHeight
      },
      scrollPosition: {
        x: window.scrollX,
        y: window.scrollY
      },
      totalHeight: document.documentElement.scrollHeight
    };
    
    return {
      interactiveElements,
      metadata
    };
  });
}

// Improve the sendMessageToAssistant function
async function sendMessageToAssistant(thread, page, prompt, currentStep) {
  try {
    // Get detailed DOM info
    const domInfo = await getDetailedDomInfo(page);
    
    // Take a screenshot
    const screenshotPath = `screenshots/step_${Date.now()}.png`;
    await page.screenshot({ 
      path: screenshotPath, 
      fullPage: false 
    });
    
    // Upload to ImgBB
    const imgbbUrl = await uploadScreenshot(screenshotPath);
    
    if (imgbbUrl) {
      // Create a message with detailed context
      const messageContent = `Current page state:
URL: ${domInfo.metadata.url}
Title: ${domInfo.metadata.title}
Task: Create a list of ${prompt}
Step: ${currentStep}

Screenshot: ${imgbbUrl}

Available interactive elements:
${JSON.stringify(domInfo.interactiveElements.slice(0, 15), null, 2)}

Page metadata:
${JSON.stringify(domInfo.metadata, null, 2)}

I need you to help me navigate this page to create a list of ${prompt}.
Look at the screenshot and the available elements to determine the next action.

What is the next action to take? Respond with ONLY a JSON object with these fields:
{
  "action": "click" | "fill" | "press",
  "selector": "The most specific selector that will work",
  "value": "Text to enter (for fill action)",
  "description": "Human readable description of the action"
}`;

      // Log what we're sending
      console.log('\n' + '='.repeat(80));
      console.log('SENDING TO ASSISTANT:');
      console.log('-'.repeat(80));
      console.log(messageContent);
      console.log('='.repeat(80) + '\n');
      
      // Send the message
      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: messageContent
      });
      
      console.log("Sent detailed page info to assistant");
      await logMessage(messageContent, 'to-ai');
      return true;
    } else {
      throw new Error("Failed to upload screenshot");
    }
  } catch (error) {
    console.error("Error sending message to assistant:", error);
    return false;
  }
}

// Improve the executeAction function to handle more cases
async function executeAction(page, action) {
  try {
    console.log('Executing action:', action);
    
    if (!action || !action.action) {
      return { success: false, error: 'Invalid action object' };
    }
    
    switch (action.action) {
      case 'click':
        // Try JavaScript evaluation first for more complex cases
        if (action.selector.includes('Email') || action.description.includes('Email')) {
          // Special handling for Email checkbox
          const emailClicked = await page.evaluate(() => {
            // Find elements containing "Email" text
            const elements = Array.from(document.querySelectorAll('div, label, span'));
            const emailElements = elements.filter(el => el.textContent.includes('Email'));
            
            if (emailElements.length > 0) {
              // Try clicking the element itself
              emailElements[0].click();
              
              // Also try to find and click a nearby checkbox
              const checkbox = emailElements[0].querySelector('input[type="checkbox"]') || 
                              emailElements[0].parentElement.querySelector('input[type="checkbox"]');
              if (checkbox) {
                checkbox.click();
                return true;
              }
              return true;
            }
            return false;
          });
          
          if (emailClicked) {
            console.log('Successfully clicked Email element using JavaScript');
            return { success: true };
          }
        }
        
        // Try multiple selector strategies
        const selectors = [
          action.selector,
          `text=${action.selector}`,
          `text="${action.selector}"`,
          `[placeholder="${action.selector}"]`,
          `button:has-text("${action.selector}")`,
          `div:has-text("${action.selector}")`,
          `.${action.selector.replace(/\s+/g, '.')}`,
          `#${action.selector.replace(/\s+/g, '_')}`
        ];
        
        for (const selector of selectors) {
          try {
            await page.click(selector);
            console.log(`Successfully clicked: ${selector}`);
            return { success: true };
          } catch (e) {
            console.log(`Failed to click ${selector}, trying next...`);
          }
        }
        
        // If all selectors fail, try a more general approach
        const clickedByText = await page.evaluate((text) => {
          const elements = Array.from(document.querySelectorAll('*'));
          for (const el of elements) {
            if (el.textContent.includes(text) && el.offsetParent !== null) {
              el.click();
              return true;
            }
          }
          return false;
        }, action.selector);
        
        if (clickedByText) {
          console.log(`Successfully clicked element containing text: ${action.selector}`);
          return { success: true };
        }
        
        return { success: false, error: `Failed to click with any selector for: ${action.selector}` };
        
      case 'fill':
        // Try multiple fill selector strategies
        const fillSelectors = [
          action.selector,
          `[placeholder="${action.selector}"]`,
          `input[placeholder="${action.selector}"]`,
          `textarea[placeholder="${action.selector}"]`,
          `input[type="text"]`,
          `input[type="search"]`,
          `input:visible`
        ];
        
        for (const selector of fillSelectors) {
          try {
            await page.fill(selector, action.value);
            console.log(`Successfully filled: ${selector}`);
            return { success: true };
          } catch (e) {
            console.log(`Failed to fill ${selector}, trying next...`);
          }
        }
        
        // If all selectors fail, try JavaScript
        const filledByJS = await page.evaluate((value) => {
          const inputs = Array.from(document.querySelectorAll('input, textarea'));
          for (const input of inputs) {
            if (input.offsetParent !== null) {
              input.value = value;
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            }
          }
          return false;
        }, action.value);
        
        if (filledByJS) {
          console.log(`Successfully filled input using JavaScript: ${action.value}`);
          return { success: true };
        }
        
        return { success: false, error: `Failed to fill with any selector for: ${action.selector}` };
        
      case 'press':
        try {
          await page.press(action.selector || 'body', action.key);
          console.log(`Successfully pressed ${action.key}`);
          return { success: true };
        } catch (e) {
          console.log(`Failed to press ${action.key}: ${e.message}`);
          return { success: false, error: e.message };
        }
        
      default:
        return { success: false, error: `Unknown action type: ${action.action}` };
    }
  } catch (error) {
    console.error('Action execution error:', error);
    return { success: false, error: error.message };
  }
}

// Add a function to get more detailed page information
async function getDetailedPageInfo(page) {
  return await page.evaluate(() => {
    // Get all interactive elements
    const getElements = () => {
      const elements = [];
      
      // Get all buttons
      document.querySelectorAll('button, [role="button"], a.btn, .btn, [class*="button"]').forEach(el => {
        const text = el.textContent.trim();
        if (text) {
          elements.push({
            type: 'button',
            text: text,
            classes: el.className,
            id: el.id || '',
            visible: el.offsetParent !== null
          });
        }
      });
      
      // Get all inputs
      document.querySelectorAll('input, textarea, select').forEach(el => {
        elements.push({
          type: el.type || el.tagName.toLowerCase(),
          placeholder: el.placeholder || '',
          name: el.name || '',
          id: el.id || '',
          classes: el.className,
          visible: el.offsetParent !== null
        });
      });
      
      // Get all checkboxes
      document.querySelectorAll('input[type="checkbox"], .checkbox, [role="checkbox"]').forEach(el => {
        elements.push({
          type: 'checkbox',
          id: el.id || '',
          classes: el.className,
          visible: el.offsetParent !== null
        });
      });
      
      return elements;
    };
    
    return {
      elements: getElements(),
      url: window.location.href,
      title: document.title
    };
  });
}

// Add a helper function to extract more useful information from the page
async function getEnhancedPageState(page) {
  try {
    const [url, title] = await Promise.all([
      page.evaluate(() => window.location.href),
      page.evaluate(() => document.title)
    ]);

    // Get more detailed page information
    const pageInfo = await page.evaluate(() => {
      // Get all interactive elements
      const elements = Array.from(document.querySelectorAll('button, a, input, select, textarea, [role="button"]'))
        .filter(el => {
          const rect = el.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && 
                 window.getComputedStyle(el).display !== 'none' &&
                 window.getComputedStyle(el).visibility !== 'hidden';
        })
        .map(el => {
          return {
            tag: el.tagName.toLowerCase(),
            text: el.textContent?.trim() || '',
            type: el.getAttribute('type') || '',
            role: el.getAttribute('role'),
            placeholder: el.getAttribute('placeholder'),
            ariaLabel: el.getAttribute('aria-label'),
            id: el.id || '',
            name: el.getAttribute('name') || '',
            classes: Array.from(el.classList),
            isEnabled: !el.disabled
          };
        });

      // Get all headings
      const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'))
        .map(h => h.textContent?.trim() || '');

      return { elements, headings };
    });

    // Take a screenshot
    const screenshotPath = `screenshots/step_${Date.now()}.png`;
    await page.screenshot({ path: screenshotPath, fullPage: true });

    return {
      url,
      title,
      elements: pageInfo.elements,
      headings: pageInfo.headings,
      screenshotPath,
      page // Include the page object for later use
    };
  } catch (error) {
    console.error('Error getting enhanced page state:', error);
    return { 
      url: '', 
      title: '', 
      elements: [], 
      headings: [], 
      error: error.message,
      page
    };
  }
}

// Update the sendPlaywrightMapToAssistant function to provide general guidance
async function sendPlaywrightMapToAssistant(thread) {
  const playwrightGuidance = `
I'll be helping you navigate Resquared to create a list of businesses.

Here are some tips for navigating the site:
1. After login, you'll need to search for businesses
2. You can filter results by contact info (like email)
3. You can select businesses and create a list

When providing actions, use these selector strategies:
1. For textboxes: input[type="text"], input[placeholder="Search"]
2. For buttons: button, button:has-text("Button Text")
3. For text elements: text="Contact Info"
4. For checkboxes: input[type="checkbox"]

I'll send you screenshots of the page at each step so you can see what's available.
`;

  await openai.beta.threads.messages.create(thread.id, {
    role: "user",
    content: playwrightGuidance
  });
  
  console.log("Sent Playwright guidance to assistant");
  await logMessage(playwrightGuidance, 'to-ai');
}

// Function to get assistant response
async function getAssistantResponse(thread, run) {
  try {
    let status = run.status;
    console.log('Run status:', status);
    
    // Poll for completion
    while (status !== 'completed' && status !== 'failed' && status !== 'cancelled') {
      await new Promise(resolve => setTimeout(resolve, 1000));
      const updatedRun = await openai.beta.threads.runs.retrieve(thread.id, run.id);
      status = updatedRun.status;
      console.log('Run status:', status);
    }
    
    if (status !== 'completed') {
      console.error(`Run ended with status: ${status}`);
      return null;
    }
    
    // Get messages added by the assistant
    const messages = await openai.beta.threads.messages.list(thread.id);
    
    // Find the last assistant message
    const assistantMessages = messages.data.filter(msg => msg.role === 'assistant');
    if (assistantMessages.length === 0) {
      console.error('No assistant messages found');
      return null;
    }
    
    const lastMessage = assistantMessages[0];
    
    // Log the full message for debugging
    console.log('\n' + '='.repeat(80));
    console.log('FULL ASSISTANT RESPONSE:');
    console.log('-'.repeat(80));
    console.log(JSON.stringify(lastMessage, null, 2));
    console.log('='.repeat(80) + '\n');
    
    // Extract the content
    if (lastMessage.content && lastMessage.content.length > 0) {
      const content = lastMessage.content[0];
      if (content.type === 'text') {
        await logMessage(content.text.value, 'from-ai');
        return content.text.value;
      }
    }
    
    console.error('No text content found in assistant message');
    return null;
  } catch (error) {
    console.error('Error getting assistant response:', error);
    return null;
  }
}

// Helper function to safely parse JSON
function safeJsonParse(text) {
  try {
    // Try to extract JSON from the text if it's wrapped in backticks
    const jsonMatch = text.match(/```(?:json)?(.*?)```/s);
    const jsonText = jsonMatch ? jsonMatch[1].trim() : text.trim();
    
    return JSON.parse(jsonText);
  } catch (error) {
    console.error('Error parsing JSON:', error);
    console.error('Original text:', text);
    // Return a default action if parsing fails
    return {
      action: 'wait',
      duration: 1000,
      description: 'Waiting after JSON parse error'
    };
  }
}

// Add a function to specifically handle the Resquared search
async function clickResquaredSearch(page) {
  try {
    // Try specific selectors for the Resquared search component
    const searchSelectors = [
      '.search-tab-filter-list-item-inner',
      '.search-tab-filters-list-item-header',
      'div.search-tab-filters-list-item-header',
      'div:has-text("Search")',
      'div.search-tab-filter-list-item-inner:has-text("Search")'
    ];
    
    for (const selector of searchSelectors) {
      try {
        await page.click(selector);
        console.log(`Successfully clicked search using: ${selector}`);
        return true;
      } catch (e) {
        console.log(`Failed to click search with ${selector}`);
      }
    }
    
    return false;
  } catch (error) {
    console.error("Error clicking search:", error);
    return false;
  }
}

// Add a function to specifically handle the checkbox issue
async function clickEmailCheckbox(page) {
  try {
    // Try multiple approaches to find and click the email checkbox
    const checkboxSelectors = [
      '.checkbox-square',
      'input[type="checkbox"]',
      '[role="checkbox"]',
      'div.checkbox',
      'div:has-text("Email")',
      'div:has-text("Email") input',
      'div:has-text("Email") .checkbox',
      'div:has-text("Email") .checkbox-square'
    ];
    
    for (const selector of checkboxSelectors) {
      try {
        // First try to find the element
        const elements = await page.$$(selector);
        console.log(`Found ${elements.length} elements with selector: ${selector}`);
        
        if (elements.length > 0) {
          // Try to click each element
          for (let i = 0; i < elements.length; i++) {
            try {
              await elements[i].click();
              console.log(`Successfully clicked checkbox using: ${selector} (element ${i})`);
              return true;
            } catch (e) {
              console.log(`Failed to click element ${i} with ${selector}`);
            }
          }
        }
      } catch (e) {
        console.log(`Error with selector ${selector}: ${e.message}`);
      }
    }
    
    // If all selectors fail, try a more aggressive approach
    try {
      await page.evaluate(() => {
        // Find all checkboxes by appearance
        const elements = document.querySelectorAll('div');
        for (const el of elements) {
          if (el.textContent.includes('Email')) {
            el.click();
            console.log('Clicked element containing Email text');
          }
        }
      });
      console.log('Attempted JavaScript click on elements containing Email');
      return true;
    } catch (e) {
      console.log('JavaScript click approach failed:', e.message);
    }
    
    return false;
  } catch (error) {
    console.error("Error clicking email checkbox:", error);
    return false;
  }
}

// Campaign automation endpoint
app.post('/run-campaign', async (req, res) => {
  let browser = null;
  let context = null;
  let page = null;
  
  try {
    const { prompt, saasUrl, saasUsername, saasPassword } = req.body;
    console.log(`Starting campaign with prompt: ${prompt}`);

    // Use your existing assistant instead of creating a new one
    const assistantId = "asst_3dilyQ1ETfB48ETN6dVSZxFd";
    const assistant = await openai.beta.assistants.retrieve(assistantId);
    
    console.log('Using existing assistant with ID:', assistant.id);
    await logMessage(`Using existing assistant: ${assistant.name}`, 'to-ai');

    // Create a thread
    const thread = await openai.beta.threads.create();
    console.log('Created thread with ID:', thread.id);

    // Send the Playwright map to the assistant
    await sendPlaywrightMapToAssistant(thread);
    
    // Initialize Hyperbrowser
    console.log("Connecting to Hyperbrowser...");
    browser = await chromium.connectOverCDP(
      `wss://connect.hyperbrowser.ai?apiKey=${process.env.HYPERBROWSER_API_KEY}`
    );
    
    console.log("Creating browser context...");
    context = await browser.newContext({
      viewport: { width: 1280, height: 720 }
    });
    
    console.log("Creating new page...");
    page = await context.newPage();

    // Track steps
    const automationSteps = [];
    let currentStep = 0;

    // Navigate to start URL
    console.log(`Navigating to ${saasUrl}...`);
    await page.goto(ensureUrlProtocol(saasUrl));
    await page.waitForLoadState('domcontentloaded');

    // Handle login steps explicitly
    const loginSteps = [
      {
        action: 'fill',
        selector: 'input[type="email"], input[placeholder="Email"]',
        value: saasUsername,
        description: 'Fill email field'
      },
      {
        action: 'fill',
        selector: 'input[type="password"], input[placeholder="Password"]',
        value: saasPassword,
        description: 'Fill password field'
      },
      {
        action: 'click',
        selector: 'button[type="submit"], button:has-text("Log in")',
        description: 'Click login button'
      }
    ];

    // Execute login steps
    for (const action of loginSteps) {
      console.log(`\nLogin Step ${currentStep + 1}`);
      console.log('Executing action:', action);
      
      const result = await executeAction(page, action);
      automationSteps.push({
        step: currentStep,
        action,
        result
      });
      
      if (!result.success) {
        console.error('Login step failed:', result.error);
      }
      
      await page.waitForTimeout(1000);
      currentStep++;
    }

    // Wait for navigation after login
    await page.waitForLoadState('networkidle');
    
    // Main automation loop with improved handling
    let consecutiveFailures = 0;
    
    while (currentStep < 20 && consecutiveFailures < 3) {
      console.log(`\nStep ${currentStep + 1}`);
      
      // Show agent status
      await showAgentStatus(page, "Analyzing page...", currentStep + 1);
      
      // Special case for the first step after login - click on Search
      if (currentStep === 3) {
        await showAgentStatus(page, "Clicking on Search section...", currentStep + 1);
        console.log("Special case: Clicking on Search section");
        await page.waitForTimeout(1000);
        
        const searchClicked = await page.evaluate(() => {
          const searchElements = Array.from(document.querySelectorAll('*'))
            .filter(el => el.textContent.includes('Search') && el.offsetParent !== null);
          
          if (searchElements.length > 0) {
            searchElements[0].click();
            return true;
          }
          return false;
        });
        
        if (searchClicked) {
          console.log("Successfully clicked Search using JavaScript");
          currentStep++;
          await page.waitForTimeout(1000);
          continue;
        }
      }
      
      // Send message to assistant with current page state
      await showAgentStatus(page, "Sending page to AI assistant...", currentStep + 1);
      const messageSent = await sendMessageToAssistant(thread, page, prompt, currentStep);
      
      if (!messageSent) {
        console.error("Failed to send message to assistant");
        consecutiveFailures++;
        continue;
      }
      
      // Run the assistant
      await showAgentStatus(page, "Waiting for AI response...", currentStep + 1);
      const run = await openai.beta.threads.runs.create(thread.id, {
        assistant_id: assistant.id
      });
      
      // Get the assistant's response
      const assistantContent = await getAssistantResponse(thread, run);
      if (!assistantContent) {
        consecutiveFailures++;
        continue;
      }
      
      // Parse the action
      const action = safeJsonParse(assistantContent);
      console.log('Parsed action:', action);
      
      // Execute the action
      await showAgentStatus(page, `Executing: ${action.description || action.action}`, currentStep + 1);
      const result = await executeAction(page, action);
      
      // Record the step
      automationSteps.push({
        step: currentStep,
        action,
        result
      });
      
      if (result.success) {
        consecutiveFailures = 0;
        currentStep++;
        await page.waitForTimeout(1000);
      } else {
        console.error('Action failed:', result.error);
        consecutiveFailures++;
      }
    }
    
    // Hide the status when done
    await hideAgentStatus(page);
    
    // Check if we completed successfully or hit the failure limit
    if (consecutiveFailures >= 3) {
      console.log("Too many consecutive failures, falling back to direct script");
      const automationSuccess = await automateResquared(page, prompt);
      
      if (automationSuccess) {
        res.json({
          success: true,
          message: 'Campaign completed with fallback to direct script',
          details: automationSteps
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Both AI and direct automation failed'
        });
      }
    } else {
      res.json({
        success: true,
        message: 'Campaign execution completed with AI assistant',
        details: automationSteps
      });
    }
  } catch (error) {
    console.error("Campaign execution error:", error);
    return res.status(500).json({
      success: false,
      error: error.message || 'Unknown error occurred'
    });
  } finally {
    // Cleanup
    if (page) await page.close().catch(console.error);
    if (context) await context.close().catch(console.error);
    if (browser) await browser.close().catch(console.error);
  }
});

// Helper function to ensure URL has protocol
function ensureUrlProtocol(url) {
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'https://' + url;
  }
  return url;
}

// Error handling
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Start server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});