// test-assistant.js
require('dotenv').config();
const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const ASSISTANT_ID = 'asst_PDNYV8vyeX74cPPqkrS6Kfnm';

async function testAssistant() {
  try {
    // Create a thread
    console.log("Creating thread...");
    const thread = await openai.beta.threads.create();
    console.log(`Thread created: ${thread.id}`);
    
    // Add a message
    console.log("Adding message...");
    await openai.beta.threads.messages.create(
      thread.id,
      {
        role: "user",
        content: "I need to search for pizza places in Resquared. What action should I take?"
      }
    );
    
    // Run the assistant
    console.log("Running assistant...");
    const run = await openai.beta.threads.runs.create(
      thread.id,
      {
        assistant_id: ASSISTANT_ID,
        instructions: "You are a web automation expert. Return ONLY a valid JSON object with the next action to take."
      }
    );
    
    // Poll for completion
    console.log("Polling for completion...");
    let status = "in_progress";
    while (status === "in_progress" || status === "queued") {
      const runStatus = await openai.beta.threads.runs.retrieve(
        thread.id,
        run.id
      );
      status = runStatus.status;
      console.log(`Run status: ${status}`);
      
      if (status === "completed") {
        break;
      }
      
      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Get the response
    console.log("Getting response...");
    const messages = await openai.beta.threads.messages.list(
      thread.id
    );
    
    const assistantMessages = messages.data.filter(msg => msg.role === 'assistant');
    if (assistantMessages.length > 0) {
      console.log("\n==== ASSISTANT RESPONSE ====\n");
      console.log(assistantMessages[0].content[0].text.value);
      console.log("\n===========================\n");
    } else {
      console.log("No assistant response found");
    }
    
  } catch (error) {
    console.error("Error:", error);
  }
}

testAssistant();