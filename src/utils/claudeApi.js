/**
 * Claude API Communication Module
 *
 * Handles all interactions with the Anthropic Claude API via proxy server
 */

const PROXY_API_URL = 'http://localhost:3001/api/chat';

/**
 * Send a message to Claude and get a response
 * @param {string} apiKey - The Anthropic API key
 * @param {string} userMessage - The user's prompt
 * @param {Array} conversationHistory - Previous messages in the conversation
 * @returns {Promise<Object>} Response containing text and any R code blocks
 */
export async function sendMessageToClaude(apiKey, userMessage, conversationHistory = []) {
  try {
    // Call the proxy server instead of Anthropic API directly
    const response = await fetch(PROXY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apiKey: apiKey,
        messages: [
          ...conversationHistory,
          {
            role: 'user',
            content: userMessage
          }
        ]
      })
    });

    // Get response text first
    const responseText = await response.text();

    // Check if response is empty
    if (!responseText) {
      throw new Error('Empty response from server. The backend may not be running properly.');
    }

    // Try to parse JSON
    let result;
    try {
      result = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse response:', responseText);
      throw new Error(`Server returned invalid JSON. Response: ${responseText.substring(0, 200)}`);
    }

    // Handle error responses
    if (!response.ok) {
      throw new Error(result.error || `API request failed: ${response.status}`);
    }

    // Validate response structure
    if (!result.success || !result.data) {
      throw new Error('Invalid response structure from server');
    }

    const data = result.data;

    // Validate Claude API response structure
    if (!data.content || !Array.isArray(data.content) || data.content.length === 0) {
      throw new Error('Invalid response format from Claude API');
    }

    const assistantMessage = data.content[0].text;

    // Extract R code blocks from the response
    const rCodeBlocks = extractRCodeBlocks(assistantMessage);

    return {
      text: assistantMessage,
      rCodeBlocks,
      fullResponse: data
    };
  } catch (error) {
    console.error('Error calling Claude API:', error);

    // Provide more helpful error messages
    if (error.name === 'TypeError' && error.message.includes('fetch')) {
      throw new Error('Cannot connect to proxy server. Make sure the backend is running on port 3001. Run: npm run server');
    }

    throw error;
  }
}

/**
 * Extract R code blocks from markdown text
 * @param {string} text - The markdown text containing code blocks
 * @returns {Array} Array of objects with code and summary
 */
function extractRCodeBlocks(text) {
  const rCodeRegex = /```r\n([\s\S]*?)```/g;
  const blocks = [];
  let match;

  while ((match = rCodeRegex.exec(text)) !== null) {
    const code = match[1].trim();
    const summary = generateCodeSummary(code);
    blocks.push({ code, summary });
  }

  return blocks;
}

/**
 * Generate a brief summary of R code
 * @param {string} code - The R code
 * @returns {string} A summary of what the code does
 */
function generateCodeSummary(code) {
  const lines = code.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));

  if (lines.length === 0) return 'R code snippet';

  // Look for key functions to describe the code
  if (code.includes('ggplot') || code.includes('plot(')) {
    return 'Create visualization/plot';
  } else if (code.includes('read.csv') || code.includes('read.table')) {
    return 'Load and process data file';
  } else if (code.includes('lm(') || code.includes('glm(')) {
    return 'Perform statistical modeling';
  } else if (code.includes('summary(') || code.includes('str(')) {
    return 'Analyze data summary statistics';
  } else if (code.includes('merge') || code.includes('join')) {
    return 'Merge/join datasets';
  } else {
    // Default: use first significant line
    const firstLine = lines[0].substring(0, 50);
    return firstLine.length < 50 ? firstLine : firstLine + '...';
  }
}
