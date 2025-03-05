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
import { parseRecording } from './recordingParser.js';
import { buildAdvancedDomSnapshot } from './advancedDomSnapshot.js';

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
You are helping search for and create a list of specific businesses in Resquared.
You'll get the current page state with interactive elements and their exact selectors.
Your task is to suggest ONE action at a time using ONLY the provided selectors.

Steps to follow (pick one based on page state):
1. If not on search page, click "Search" link (selector: text="Search")
2. Click the search header to expand (selector: .search-tab-filters-list-item-header)
3. Fill the search input (selector: input[placeholder="Search"])
4. Press Enter to submit (selector: input[placeholder="Search"])
5. Click "Save to List" to save results (selector: text="Save to List")
6. Wait if content is loading (duration: 2000)

Available selectors (use EXACTLY as shown):
- Search header: .search-tab-filters-list-item-header
- Search input: input[placeholder="Search"]
- Apply button: text="Apply"
- Save to List: text="Save to List"
- Search link: text="Search"

IMPORTANT: Respond with EXACTLY this JSON format:
{
  "action": "click" | "fill" | "press" | "wait",
  "selector": "Exact selector from the elements list",
  "value": "text to enter (for fill action)",
  "key": "key to press (for press action)",
  "duration": "time in ms (for wait action)",
  "description": "Human readable description"
}

Example responses:
{"action": "click", "selector": ".search-tab-filters-list-item-header", "description": "Expand search section"}
{"action": "fill", "selector": "input[placeholder=\"Search\"]", "value": "pizza", "description": "Search for pizza places"}
{"action": "press", "selector": "input[placeholder=\"Search\"]", "key": "Enter", "description": "Submit search"}
{"action": "wait", "duration": "2000", "description": "Wait for results"}

RULES:
1. Use ONLY the exact selectors shown above - no variations or "element" objects
2. ONE action at a time - no lists or multi-step plans
3. Check the page URL and elements to decide the next step
4. For search terms, extract the business type (e.g., "pizza" from "make a list of pizza places")
5. Add a wait action after any action that loads new content
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

/**
 * Fix the URL protocol function to properly handle malformed URLs
 * - Removes any "https:://" pattern (double colon)
 * - Removes any duplicate protocols like https://https://
 * - Adds protocol if missing
 */
function ensureUrlProtocol(url) {
  // First, remove any "https:://" pattern (double colon)
  url = url.replace(/https?::\/\//g, 'https://');
  
  // Then, remove any duplicate protocols like https://https://
  url = url.replace(/https?:\/\/(https?:\/\/)/g, '$1');
  
  // Finally, add protocol if missing
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return 'https://' + url;
  }
  return url;
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

// If you want to upload to OpenAI directly, you can keep or remove this
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

// Add a function to get detailed DOM information for the assistant
async function getDetailedDomInfo(page) {
  return await page.evaluate(() => {
    // Helper function to safely get class names as a string
    const getClassNames = (el) => {
      if (!el) return '';
      if (typeof el.className === 'string') return el.className;
      if (el.className?.baseVal) return el.className.baseVal; // For SVG elements
      if (el.classList?.value) return el.classList.value;
      if (el.classList) return Array.from(el.classList).join(' ');
      return '';
    };

    // Helper function to get visible text
    const getVisibleText = (el) => {
      if (!el) return '';
      const text = el.innerText?.trim() || el.textContent?.trim() || '';
      const ariaLabel = el.getAttribute?.('aria-label')?.trim() || '';
      return text || ariaLabel || '';
    };

    // Helper function to check visibility
    const isVisible = (el) => {
      try {
        if (!el || !el.getBoundingClientRect) return false;
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return el.offsetParent !== null && 
               style.display !== 'none' && 
               style.visibility !== 'hidden' && 
               rect.width > 0 && 
               rect.height > 0;
      } catch (e) {
        return false;
      }
    };

    // Helper function to check if element is interactive
    const isInteractive = (el) => {
      try {
        if (!el) return false;
        
        // Check for native interactive elements
        if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) {
          return true;
        }

        // Check for role attributes
        if (el.getAttribute('role') === 'button' || 
            el.getAttribute('role') === 'link' || 
            el.getAttribute('role') === 'checkbox') {
          return true;
        }

        // Check for click handlers
        if (el.onclick || el.getAttribute('onclick')) {
          return true;
        }

        // Check class names for interactive indicators
        const classNames = getClassNames(el).toLowerCase();
        const parentClassNames = getClassNames(el.parentElement).toLowerCase();
        const interactiveClasses = ['checkbox', 'button', 'clickable', 'selectable'];
        
        return interactiveClasses.some(cls => 
          classNames.includes(cls) || parentClassNames.includes(cls)
        );
      } catch (e) {
        return false;
      }
    };

    // Get all elements
    const elements = [];
    try {
      document.querySelectorAll('*').forEach(el => {
        try {
          if (!el || !el.tagName || !isVisible(el)) return;

          // Skip if parent is already included
          if (elements.some(e => e.element === el.parentElement)) return;

          let type = null;
          let selector = null;
          let description = null;

          // Determine element type and selector
          if (el.tagName === 'BUTTON' || el.getAttribute('role') === 'button') {
            type = 'button';
            selector = `button:has-text("${getVisibleText(el)}")`;
          } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
            type = el.type || 'text';
            const placeholder = el.getAttribute('placeholder');
            selector = placeholder ? 
              `input[placeholder="${placeholder}"]` : 
              `input[type="${el.type || 'text'}"]`;
          } else if (el.tagName === 'A') {
            type = 'link';
            selector = `a:has-text("${getVisibleText(el)}")`;
          } else if (getClassNames(el).includes('checkbox') || 
                     el.getAttribute('role') === 'checkbox') {
            type = 'checkbox';
            selector = el.id ? 
              `#${el.id}` : 
              `.${getClassNames(el).split(' ')[0]}`;
            description = `Checkbox: ${getVisibleText(el)}`;
          } else if (isInteractive(el)) {
            type = 'interactive';
            const text = getVisibleText(el);
            selector = text ? 
              `text="${text}"` : 
              `.${getClassNames(el).split(' ')[0]}`;
            description = `Interactive element: ${text}`;
          }

          if (type) {
            elements.push({
              type,
              text: getVisibleText(el),
              selector,
              description,
              classes: getClassNames(el).split(' ').filter(Boolean),
              interactable: true,
              element: el
            });
          }
        } catch (e) {
          console.error('Error processing element:', e);
        }
      });
    } catch (e) {
      console.error('Error querying elements:', e);
    }

    return {
      url: window.location.href,
      title: document.title,
      elements: elements
        .filter(e => e.interactable)
        .map(({ element, ...rest }) => rest) // Remove DOM element before serializing
    };
  });
}

// Add a function to validate search results
async function validateSearchResults(page) {
  try {
    // Check for either results or no results indicator
    const hasResults = await Promise.race([
      page.waitForSelector('.search-businesses-header-checkbox', { timeout: 5000 })
        .then(() => 'results'),
      page.waitForSelector('.no-results-found', { timeout: 5000 })
        .then(() => 'no-results'),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 5000))
    ]);
    
    console.log('Search results status:', hasResults);
    return hasResults === 'results';
  } catch (error) {
    console.error('Error validating search results:', error);
    return false;
  }
}

// Function to send a message to the AI assistant with a screenshot
async function sendMessageToAssistant(thread, page, prompt, currentStep) {
  try {
    // Get detailed DOM info
    const domInfo = await getDetailedDomInfo(page);
    
    // Take a screenshot
    const screenshotPath = `screenshots/step_${currentStep}_${Date.now()}.png`;
    await page.screenshot({
      path: screenshotPath,
      fullPage: false
    });
    
    // Upload to ImgBB
    const imgbbUrl = await uploadScreenshot(screenshotPath);
    
    if (imgbbUrl) {
      // Create a message with detailed context
      const messageContent = `
        Current Goal: Create a list of "${prompt}" businesses in Resquared
        Current Page: ${domInfo.title} (${domInfo.url})
        
        Past Actions:
        ${automationSteps.map(step => 
          `Step ${step.step}: ${step.action.action} on ${step.action.selector} - ${step.result.success ? 'Success' : 'Failed: ' + step.result.error}`
        ).join('\n')}
        
        Available Interactive Elements:
        ${domInfo.elements.map(el => `
          Type: ${el.type}
          Text: "${el.text || ''}"
          Selector: "${el.selector}"
          Description: ${el.description || ''}
          ---
        `).join('\n')}
        
        Screenshot: ${imgbbUrl}
        
        Instructions:
        1. If you see search results, look for ways to select businesses (checkboxes, select all options)
        2. After selecting businesses, look for "Save to List" or similar options
        3. Try clicking interactive elements that might help complete the task
        4. If you're not sure what to do, try exploring visible interactive elements
        
        What is the next action to take? Respond with a JSON object containing:
        {
          "action": "click" | "fill" | "press" | "wait",
          "selector": "The element's selector",
          "value": "For fill actions",
          "key": "For press actions",
          "description": "What this action will do"
        }
        
        Or respond with "COMPLETE" if the list has been created successfully.
      `;
      await logMessage(messageContent, 'to-ai');
      
      // Send the message to the assistant
      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: messageContent
      });
      
      return true;
    } else {
      console.error("Failed to upload screenshot");
      return false;
    }
  } catch (error) {
    console.error("Error sending message to assistant:", error);
    return false;
  }
}

// Function to get the assistant's response
async function getAssistantResponse(thread, run) {
  try {
    // Poll for the run to complete
    let runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    console.log('Run status:', runStatus.status);
    
    while (runStatus.status === 'queued' || runStatus.status === 'in_progress') {
      console.log('Run status:', runStatus.status);
      await new Promise(resolve => setTimeout(resolve, 1000));
      runStatus = await openai.beta.threads.runs.retrieve(thread.id, run.id);
    }
    
    if (runStatus.status === 'completed') {
      // Get the assistant's messages
      const messages = await openai.beta.threads.messages.list(thread.id);
      
      // Find the latest assistant message
      const assistantMessages = messages.data.filter(msg => msg.role === 'assistant');
      if (assistantMessages.length > 0) {
        const latestMessage = assistantMessages[0];
        const content = latestMessage.content[0].text.value;
        
        await logMessage(content, 'from-ai');
        return content;
      }
    }
    console.error('Run failed or timed out:', runStatus.status);
    return null;
  } catch (error) {
    console.error('Error getting assistant response:', error);
    return null;
  }
}

// Safe JSON parse for AI messages
function safeJsonParse(text) {
  try {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return JSON.parse(text);
  } catch (error) {
    console.error('Error parsing JSON:', error);
    return {
      action: "click",
      selector: "button",
      description: "Default action due to parsing error"
    };
  }
}

// Add the executeAction function
async function executeAction(page, action) {
  let selector = action.selector;
  let validAction = action.action;
  
  // Force invalid formats to valid ones
  if (!selector || !['click', 'fill', 'press', 'wait'].includes(validAction)) {
    selector = '.search-tab-filters-list-item-header';
    validAction = 'click';
    
    // Handle search-related actions
    if (action.searchText || action.inputFields || action.search_query) {
      selector = 'input[placeholder="Search"]';
      validAction = 'fill';
      action.value = action.searchText || 
        action.inputFields?.find(f => f.placeholder === 'Search')?.value || 
        action.search_query || 
        'pizza';
    }
    console.log(`Forced invalid action to "${validAction}" on "${selector}"`);
  }
  
  try {
    // Special handling for search operations
    if (selector === 'input[placeholder="Search"]') {
      console.log('Handling search input action:', validAction);
      
      // For press Enter, treat it as a complete search operation
      if (validAction === 'press' && action.key === 'Enter') {
        try {
          // 1. Ensure dropdown is expanded
          await page.click('.search-tab-filters-list-item-header', { force: true });
          await page.waitForTimeout(1000);
          
          // 2. Wait for and verify input visibility
          await page.waitForSelector(selector, { state: 'visible', timeout: 20000 });
          
          // 3. Focus and press Enter
          await page.click(selector, { force: true });
          await page.waitForTimeout(500);
          
          // 4. Execute search and wait for results
          await Promise.all([
            page.waitForLoadState('networkidle', { timeout: 20000 }),
            page.press(selector, 'Enter')
          ]);
          
          // 5. Verify search completed by checking for results
          const resultsVisible = await Promise.race([
            page.waitForSelector('text="Save to List"', { timeout: 5000 })
              .then(() => true)
              .catch(() => false),
            page.waitForSelector('.no-results-found', { timeout: 5000 })
              .then(() => true)
              .catch(() => false)
          ]);
          
          if (!resultsVisible) {
            console.log('Search results not visible, retrying...');
            // Retry the search once
            await page.click(selector, { force: true });
            await Promise.all([
              page.waitForLoadState('networkidle', { timeout: 20000 }),
              page.press(selector, 'Enter')
            ]);
            
            // Final verification
            const retryResultsVisible = await Promise.race([
              page.waitForSelector('text="Save to List"', { timeout: 5000 })
                .then(() => true)
                .catch(() => false),
              page.waitForSelector('.no-results-found', { timeout: 5000 })
                .then(() => true)
                .catch(() => false)
            ]);
            
            if (!retryResultsVisible) {
              throw new Error('Search failed to show results after retry');
            }
          }
          
          return { success: true };
        } catch (searchError) {
          console.error('Search operation failed:', searchError);
          throw searchError;
        }
      }
      
      // For fill action, ensure input stays visible
      else if (validAction === 'fill') {
        // 1. Expand dropdown
        await page.click('.search-tab-filters-list-item-header', { force: true });
        await page.waitForTimeout(1000);
        
        // 2. Wait for input
        await page.waitForSelector(selector, { state: 'visible', timeout: 20000 });
        
        // 3. Fill the input
        await page.click(selector, { force: true });
        await page.fill(selector, action.value || 'pizza');
        await page.waitForTimeout(500);
        
        // 4. Verify input is still visible and focused
        const isVisible = await page.isVisible(selector);
        if (!isVisible) {
          await page.click('.search-tab-filters-list-item-header', { force: true });
          await page.waitForTimeout(500);
          await page.click(selector, { force: true });
        }
        
        return { success: true };
      }
    }
    
    // Add special handling for checkboxes
    if (action.selector?.includes('checkbox') || action.type === 'checkbox') {
      try {
        // Try multiple selectors for checkboxes
        const selectors = [
          '.search-businesses-header-checkbox',
          '.checkbox-square',
          '.list-item-checkbox'
        ];
        
        for (const selector of selectors) {
          const checkbox = await page.$(selector);
          if (checkbox) {
            await checkbox.click({ force: true });
            await page.waitForTimeout(500);
            return { success: true };
          }
        }
        
        throw new Error('No matching checkbox found');
      } catch (error) {
        console.error('Checkbox interaction failed:', error);
        return { success: false, error: error.message };
      }
    }
    
    // Handle non-search actions normally
    await page.waitForSelector(selector, { state: 'visible', timeout: 20000 });
    
    switch (validAction) {
      case 'click':
        await page.click(selector, { force: true });
        await page.waitForTimeout(1000);
        return { success: true };
        
      case 'fill':
        await page.fill(selector, action.value || '');
        await page.waitForTimeout(500);
        return { success: true };
        
      case 'press':
        await page.press(selector, action.key || 'Enter');
        await page.waitForLoadState('networkidle', { timeout: 20000 });
        return { success: true };
        
      case 'wait':
        await page.waitForTimeout(parseInt(action.duration) || 2000);
        return { success: true };
        
      default:
        return { success: false, error: `Unknown action: ${validAction}` };
    }
  } catch (error) {
    console.error(`Action ${validAction} failed on ${selector}:`, error.message);
    await page.screenshot({ path: `screenshots/error_${Date.now()}.png` });
    
    // Special retry for search input issues
    if (selector === 'input[placeholder="Search"]' && error.message.includes('hidden')) {
      try {
        console.log('Retrying search input action with expanded dropdown...');
        
        // Full retry of the search operation
        await page.click('.search-tab-filters-list-item-header', { force: true });
        await page.waitForTimeout(1000);
        await page.click(selector, { force: true });
        await page.waitForTimeout(500);
        
        if (validAction === 'fill') {
          await page.fill(selector, action.value || 'pizza');
        } else if (validAction === 'press') {
          await Promise.all([
            page.waitForLoadState('networkidle', { timeout: 20000 }),
            page.press(selector, 'Enter')
          ]);
          
          // Verify search completed
          const resultsVisible = await Promise.race([
            page.waitForSelector('text="Save to List"', { timeout: 5000 })
              .then(() => true)
              .catch(() => false),
            page.waitForSelector('.no-results-found', { timeout: 5000 })
              .then(() => true)
              .catch(() => false)
          ]);
          
          if (!resultsVisible) {
            throw new Error('Search failed to show results after retry');
          }
        }
        
        return { success: true };
      } catch (retryError) {
        console.error('Retry also failed:', retryError.message);
        return { success: false, error: retryError.message };
      }
    }
    return { success: false, error: error.message };
  }
}

// Show agent status on the page
async function showAgentStatus(page, message, step) {
  try {
    const elementExists = await page.evaluate(() => {
      return !!document.getElementById('ai-agent-status');
    }).catch(() => false);
    
    if (!elementExists) {
      // Inject a status element if it doesn't exist
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
          
          const textContainer = document.createElement('div');
          textContainer.innerHTML = `
            <div id="ai-agent-step" style="font-weight: bold; margin-bottom: 5px;"></div>
            <div id="ai-agent-message"></div>
          `;
          
          statusDiv.appendChild(textContainer);
          document.body.appendChild(statusDiv);
        } catch (e) {
          // no-op
        }
      });
    }
    
    // Update the text
    await page.evaluate(({ message, step }) => {
      const stepEl = document.getElementById('ai-agent-step');
      if (stepEl) stepEl.textContent = `Step ${step}`;
      
      const msgEl = document.getElementById('ai-agent-message');
      if (msgEl) msgEl.textContent = message;
    }, { message, step });
  } catch (error) {
    console.error('Error showing agent status:', error);
  }
}

// Hide agent status
async function hideAgentStatus(page) {
  try {
    await page.evaluate(() => {
      const statusElement = document.getElementById('ai-agent-status');
      if (statusElement) {
        statusElement.style.display = 'none';
      }
    });
  } catch (error) {
    console.error('Error hiding agent status:', error);
  }
}

// Fallback automation if the AI fails
async function automateResquared(page, prompt) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    await dismissTutorialOverlay(page);
  
    const searchTerm = prompt.toLowerCase()
      .replace(/make a list of/i, '')
      .replace(/places/i, '')
      .trim();
    console.log(`Extracted search term: "${searchTerm}"`);
    
    // Expand search section and verify
    await page.click('.search-tab-filters-list-item-header', { force: true });
    await page.waitForTimeout(1000);
    
    const searchInput = 'input[placeholder="Search"]';
    await page.waitForSelector(searchInput, { state: 'visible', timeout: 20000 });
    
    // Ensure input is visible and focused
    await page.click(searchInput, { force: true });
    await page.waitForTimeout(500);
    
    // Fill the search term
    await page.fill(searchInput, searchTerm);
    await page.waitForTimeout(500);
    
    // Verify input is still visible
    const inputVisible = await page.isVisible(searchInput);
    if (!inputVisible) {
      console.log('Search input hidden after fill, re-expanding...');
      await page.click('.search-tab-filters-list-item-header', { force: true });
      await page.waitForTimeout(1000);
      await page.click(searchInput, { force: true });
      await page.waitForTimeout(500);
    }
    
    // Press Enter and wait for results
    await page.press(searchInput, 'Enter');
    await page.waitForLoadState('networkidle', { timeout: 20000 });
    
    // Verify search completed
    const saveToListVisible = await page.isVisible('text="Save to List"');
    if (!saveToListVisible) {
      console.log('Save to List not visible, retrying search...');
      await page.click(searchInput, { force: true });
      await page.press(searchInput, 'Enter');
      await page.waitForLoadState('networkidle', { timeout: 20000 });
    }
    
    // Click Save to List
    await page.waitForSelector('text="Save to List"', { timeout: 20000 });
    await page.click('text="Save to List"', { force: true });
    await page.waitForTimeout(2000);
    
    return true;
  } catch (error) {
    console.error("Fallback automation failed:", error);
    await page.screenshot({ path: `screenshots/fallback_error_${Date.now()}.png` });
    return false;
  }
}

// Add this function to your code
async function dismissTutorialOverlay(page) {
  try {
    // Try to find and click the "get started" link
    const getStartedLink = await page.locator('text=get started').first();
    if (await getStartedLink.isVisible()) {
      console.log('Found tutorial overlay, clicking "get started"');
      await getStartedLink.click();
      await page.waitForTimeout(1000); // Wait for animation
      return true;
    }
    
    // Alternative: Look for a close button
    const closeButton = await page.locator('button.close, .modal-close, [aria-label="Close"]').first();
    if (await closeButton.isVisible()) {
      console.log('Found tutorial overlay, clicking close button');
      await closeButton.click();
      await page.waitForTimeout(1000); // Wait for animation
      return true;
    }
    
    console.log('No tutorial overlay found or it was already dismissed');
    return false;
  } catch (error) {
    console.warn('Error dismissing tutorial overlay:', error.message);
    return false;
  }
}

// MAIN ENDPOINT
app.post('/run-campaign', async (req, res) => {
  const { prompt, saasUrl, saasUsername, saasPassword } = req.body;
  
  if (!prompt || !saasUrl || !saasUsername || !saasPassword) {
    return res.status(400).json({
      success: false,
      error: 'Missing required fields'
    });
  }
  
  console.log(`Starting campaign with prompt: ${prompt}`);
  
  let browser = null;
  let context = null;
  let page = null;
  const automationSteps = [];
  
  try {
    // Connect to Hyperbrowser
    console.log('Connecting to Hyperbrowser...');
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
    let currentStep = 0;

    // Navigate to start URL
    const fixedUrl = ensureUrlProtocol(saasUrl);
    console.log(`Navigating to ${fixedUrl}...`);
    await page.goto(fixedUrl);
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
    
    // Create or get existing assistant
    const assistantId = "asst_3dilyQ1ETfB48ETN6dVSZxFd";
    console.log('\nUsing existing assistant with ID:', assistantId);
    const assistant = await openai.beta.assistants.retrieve(assistantId);
    
    // Create a new thread for this session
    const thread = await openai.beta.threads.create();
    console.log('Created thread with ID:', thread.id);
    
    // Main automation loop with improved handling
    let consecutiveFailures = 0;
    
    while (currentStep < 20 && consecutiveFailures < 3) {
      // Validate page state before each action
      if (!(await validatePageState(page))) {
        console.log('Page not in correct state, retrying...');
        consecutiveFailures++;
        continue;
      }

      console.log(`\nStep ${currentStep + 1}`);
      
      // Show agent status
      await showAgentStatus(page, "Analyzing page...", currentStep + 1);
      
      // Special case for clicking Search after login
      if (currentStep === 3) {
        await showAgentStatus(page, "Clicking on Search section...", currentStep + 1);
        console.log("Special case: Clicking on Search section");
        await page.waitForTimeout(1000);
        
        try {
          // First navigate to search page if needed
          const url = await page.url();
          if (!url.includes('search-businesses')) {
            await page.click('text="Search"');
            await page.waitForTimeout(1000);
          }
          
          // Then expand the search section
          await page.click('.search-tab-filters-list-item-header', { force: true });
          await page.waitForTimeout(1000);
          
          // Verify the input is now visible
          const inputVisible = await page.isVisible('input[placeholder="Search"]');
          if (inputVisible) {
            console.log("Successfully expanded search section");
            currentStep++;
            continue;
          } else {
            throw new Error("Search input not visible after expanding section");
          }
        } catch (error) {
          console.error("Failed to expand search section:", error);
          consecutiveFailures++;
        }
      }
      
      // Get DOM info and send to assistant
      const domInfo = await getDetailedDomInfo(page);
      
      // Take and upload a screenshot
      const screenshotPath = `screenshots/step_${currentStep}.png`;
      await page.screenshot({ path: screenshotPath, fullPage: true });
      const screenshotUrl = await uploadScreenshot(screenshotPath);
      
      // Prepare message content with both DOM info and screenshot
      const messageContent = `
        Current Goal: Create a list of "${prompt}" businesses in Resquared
        Current Page: ${domInfo.title} (${domInfo.url})
        
        Past Actions:
        ${automationSteps.map(step => 
          `Step ${step.step}: ${step.action.action} on ${step.action.selector} - ${step.result.success ? 'Success' : 'Failed: ' + step.result.error}`
        ).join('\n')}
        
        Available Interactive Elements:
        ${domInfo.elements.map(el => `
          Type: ${el.type}
          Text: "${el.text || ''}"
          Selector: "${el.selector}"
          Description: ${el.description || ''}
          ---
        `).join('\n')}
        
        Screenshot: ${screenshotUrl}
        
        Instructions:
        1. If you see search results, look for ways to select businesses (checkboxes, select all options)
        2. After selecting businesses, look for "Save to List" or similar options
        3. Try clicking interactive elements that might help complete the task
        4. If you're not sure what to do, try exploring visible interactive elements
        
        What is the next action to take? Respond with a JSON object containing:
        {
          "action": "click" | "fill" | "press" | "wait",
          "selector": "The element's selector",
          "value": "For fill actions",
          "key": "For press actions",
          "description": "What this action will do"
        }
        
        Or respond with "COMPLETE" if the list has been created successfully.
      `;
      
      await logMessage(messageContent, 'to-ai');
      
      // Send message to assistant
      await openai.beta.threads.messages.create(thread.id, {
        role: "user",
        content: messageContent
      });
      
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
      
      // Parse and execute the action
      const action = safeJsonParse(assistantContent);
      console.log('Parsed action:', action);
      
      // Handle multi-step responses
      if (action.action === 'createList' && action.steps) {
        console.warn('LLM returned multi-step action, using first step');
        const firstStep = action.steps[0];
        action.action = firstStep.actionType === 'pressEnter' ? 'press' : firstStep.actionType;
        action.selector = firstStep.selector || firstStep.description.split(' ').pop().replace(/['"]/g, '');
        action.key = firstStep.actionType === 'pressEnter' ? 'Enter' : undefined;
        action.description = firstStep.description;
      }
      
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
      
      if (!automationSuccess) {
        throw new Error('Both AI and direct automation failed');
      }
    }
    
    // Return success
    res.json({
      success: true,
      message: 'Campaign completed successfully',
      details: automationSteps
    });
  } catch (error) {
    console.error('Error starting campaign:', error);
    return res.status(500).json({
      success: false,
      error: 'Error starting campaign'
    });
  } finally {
    if (page) await page.close().catch(console.error);
    if (context) await context.close().catch(console.error);
    if (browser) await browser.close().catch(console.error);
  }
});

// Add these functions back
function normalizeAssistantAction(parsed) {
  // Handle both { action: { type: "click", ... } } and { action: "click", target: {...} }
  if (parsed?.action) {
    // Case 1: action is an object with type
    if (typeof parsed.action === 'object' && parsed.action.type) {
      const top = parsed.action;
      let actionType = top.type || parsed.action;

      // If the AI provided an action=submit, transform it to "press" or "click"
      if (actionType === 'submit') {
        actionType = 'press';
      }

      const guessedSelector = guessSelector(top.target?.element || top.target);
      return {
        action: actionType,
        selector: guessedSelector || null,
        value: top.value || null,
        description: top.description || 'No description provided'
      };
    }
    // Case 2: action is a string and target is an object
    else if (typeof parsed.action === 'string' && parsed.target) {
      const actionType = parsed.action;
      const guessedSelector = guessSelector(parsed.target);
      return {
        action: actionType,
        selector: guessedSelector || null,
        value: parsed.value || null,
        description: parsed.description || 'No description provided'
      };
    }
  }
  return parsed;
}

function guessSelector(elementObj) {
  if (!elementObj) return null;
  
  // If there's a "text" field, assume a button
  if (elementObj.text) {
    // Handle different element types
    if (elementObj.type === 'link') {
      return `a:has-text("${elementObj.text}")`;
    } else if (elementObj.type === 'text') {
      return `input[placeholder="${elementObj.text}"]`;
    } else {
      return `text="${elementObj.text}"`;
    }
  }

  // If there's a placeholder, assume it's an input box
  if (elementObj.placeholder) {
    return `input[placeholder="${elementObj.placeholder}"]`;
  }

  // If there's a type and classes, use those
  if (elementObj.type && elementObj.classes) {
    if (elementObj.type === 'text') {
      return `input.${elementObj.classes.split(' ')[0]}`;
    }
  }

  // Fallback for other element types
  return null;
}

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

async function validatePageState(page) {
  try {
    // Check if search input is visible
    const searchInput = await page.$('input[placeholder="Search"]');
    if (!searchInput) {
      // Try to get to search page
      await page.click('text="Search"');
      await page.waitForTimeout(2000);
    }
    return true;
  } catch (error) {
    console.error('Page state validation failed:', error);
    return false;
  }
}