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
export async function sendMessageToClaude(apiKey, userMessage, conversationHistory = [], suggestionsEnabled = false, recentPlots = []) {
  try {
    // Call the proxy server instead of Anthropic API directly
    const response = await fetch(PROXY_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        apiKey: apiKey,
        suggestionsEnabled: suggestionsEnabled,
        recentPlots: recentPlots,  // Include plot images for Claude's vision
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

    // Extract reactive component specs from the response
    const reactiveComponents = extractReactiveComponents(assistantMessage);

    return {
      text: assistantMessage,
      rCodeBlocks,
      reactiveComponents,
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
  // Match code blocks with 'r' or 'R' language identifier
  // Handles both ```r and ```R with optional whitespace
  const rCodeRegex = /```[rR]\s*\n([\s\S]*?)```/g;
  const blocks = [];
  let match;

  while ((match = rCodeRegex.exec(text)) !== null) {
    const code = match[1].trim();
    if (code.length > 0) {  // Only add non-empty code blocks
      const { summary, description } = generateCodeSummary(code);
      blocks.push({ code, summary, description });
    }
  }

  return blocks;
}

/**
 * Generate a brief summary and description of R code
 * @param {string} code - The R code
 * @returns {Object} Object with summary (title) and description
 */
function generateCodeSummary(code) {
  const lines = code.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'));

  if (lines.length === 0) {
    return {
      summary: 'R code snippet',
      description: 'Execute R code'
    };
  }

  // Extract key functions used
  const functions = [];
  if (code.includes('ggplot')) functions.push('ggplot');
  if (code.includes('geom_')) {
    const geoms = code.match(/geom_\w+/g);
    if (geoms) functions.push(...geoms.slice(0, 2));
  }
  if (code.includes('plot(')) functions.push('plot()');
  if (code.includes('hist(')) functions.push('hist()');
  if (code.includes('barplot(')) functions.push('barplot()');
  if (code.includes('boxplot(')) functions.push('boxplot()');
  if (code.includes('lm(')) functions.push('lm()');
  if (code.includes('glm(')) functions.push('glm()');
  if (code.includes('read.csv')) functions.push('read.csv()');
  if (code.includes('read.table')) functions.push('read.table()');

  // Look for key functions to describe the code
  if (code.includes('ggplot') || code.includes('plot(')) {
    return {
      summary: 'Create visualization/plot',
      description: functions.length > 0
        ? `Using ${functions.slice(0, 3).join(', ')}`
        : 'Generate data visualization'
    };
  } else if (code.includes('read.csv') || code.includes('read.table')) {
    return {
      summary: 'Load and process data file',
      description: `Read data from file${functions.length > 1 ? ' using ' + functions.join(', ') : ''}`
    };
  } else if (code.includes('lm(') || code.includes('glm(')) {
    return {
      summary: 'Perform statistical modeling',
      description: functions.length > 0
        ? `Linear regression with ${functions.join(', ')}`
        : 'Build statistical model'
    };
  } else if (code.includes('summary(') || code.includes('str(')) {
    return {
      summary: 'Analyze data summary statistics',
      description: 'Compute descriptive statistics'
    };
  } else if (code.includes('merge') || code.includes('join')) {
    return {
      summary: 'Merge/join datasets',
      description: 'Combine multiple data sources'
    };
  } else {
    // Default: use first significant line as description
    const firstLine = lines[0].substring(0, 60);
    return {
      summary: 'R code execution',
      description: firstLine.length < 60 ? firstLine : firstLine + '...'
    };
  }
}

/**
 * Extract reactive component specs from markdown text
 * Looks for JSON code blocks marked with special comment
 * @param {string} text - The markdown text containing code blocks
 * @returns {Array} Array of reactive component spec objects
 */
function extractReactiveComponents(text) {
  // Match JSON code blocks that contain reactive component specs
  // Looking for: ```json followed by a block containing "type": "reactive-component"
  const jsonCodeRegex = /```json\s*\n([\s\S]*?)```/g;
  const components = [];
  let match;

  while ((match = jsonCodeRegex.exec(text)) !== null) {
    const jsonText = match[1].trim();
    try {
      const parsed = JSON.parse(jsonText);
      // Check if this is a reactive component spec
      if (parsed.type === 'reactive-component') {
        components.push(parsed);
      }
    } catch (e) {
      // Not valid JSON or not a reactive component, skip
      console.log('Skipped non-reactive JSON block');
    }
  }

  return components;
}
