/**
 * Backend Proxy Server
 *
 * This server proxies requests to the Anthropic API to avoid CORS issues
 * when calling the API directly from the browser
 */

import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { exec } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const app = express();
const PORT = 3001;

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Proxy server is running' });
});

/**
 * POST /api/chat
 * Proxy endpoint for Claude API requests
 *
 * Body:
 * - apiKey: Anthropic API key
 * - messages: Array of conversation messages
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { apiKey, messages } = req.body;

    if (!apiKey) {
      return res.status(400).json({
        error: 'API key is required'
      });
    }

    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({
        error: 'Messages array is required'
      });
    }

    // Initialize Anthropic client with user's API key
    const anthropic = new Anthropic({
      apiKey: apiKey,
    });

    // System prompt for data analysis assistant
    const systemPrompt = `You are a helpful data analysis assistant. When users ask you to analyze data, load files, or create visualizations, you should:

1. Provide clear explanations of what you're doing
2. Generate R code to accomplish the task
3. Wrap all R code in markdown code blocks with the 'r' language identifier

Example response format:
"I'll help you create a scatter plot of your data. Here's the R code:

\`\`\`r
# Load the data
data <- read.csv('data.csv')

# Create scatter plot
library(ggplot2)
ggplot(data, aes(x=variable1, y=variable2)) +
  geom_point() +
  theme_minimal() +
  labs(title="Scatter Plot", x="Variable 1", y="Variable 2")
\`\`\`

This code will create a beautiful scatter plot showing the relationship between the two variables."`;

    // Call Claude API
    // Using Claude 3 Opus - the most powerful model for best code generation
    const message = await anthropic.messages.create({
      model: 'claude-3-opus-20240229',
      max_tokens: 4096,
      system: systemPrompt,
      messages: messages
    });

    // Return the response
    res.json({
      success: true,
      data: message
    });

  } catch (error) {
    console.error('Error calling Claude API:', error);

    // Handle specific error types
    if (error.status === 401) {
      return res.status(401).json({
        error: 'Invalid API key. Please check your Anthropic API key.'
      });
    }

    if (error.status === 429) {
      return res.status(429).json({
        error: 'Rate limit exceeded. Please try again later.'
      });
    }

    res.status(500).json({
      error: error.message || 'An error occurred while processing your request'
    });
  }
});

/**
 * POST /api/execute-r
 * Execute R code and return results (output, plots, errors)
 *
 * Body:
 * - code: R code to execute
 */
app.post('/api/execute-r', async (req, res) => {
  const tempDir = join(tmpdir(), '3panel-r-execution');
  const timestamp = Date.now();
  const scriptPath = join(tempDir, `script_${timestamp}.R`);
  const svgPath = join(tempDir, `plot_${timestamp}.svg`);

  try {
    const { code } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        error: 'R code is required'
      });
    }

    // Create temp directory if it doesn't exist
    try {
      await mkdir(tempDir, { recursive: true });
    } catch (err) {
      // Directory might already exist, ignore error
    }

    // Check if code contains plotting
    const hasPlot = code.includes('plot(') ||
                     code.includes('ggplot') ||
                     code.includes('hist(') ||
                     code.includes('barplot') ||
                     code.includes('boxplot');

    let rCode = code;

    // If plotting, wrap code to capture SVG
    if (hasPlot) {
      rCode = `
# Load mtcars dataset
data(mtcars)

# Load svglite library
library(svglite)

# Open SVG device using svglite
svglite("${svgPath.replace(/\\/g, '/')}", width = 7, height = 5.5)

# Execute user code
tryCatch({
  ${code}
}, error = function(e) {
  cat("Error:", conditionMessage(e), "\\n")
})

# Close device
dev.off()

# Print success message
cat("Plot generated successfully\\n")
`;
    } else {
      // For non-plot code, just load mtcars and execute
      rCode = `
# Load mtcars dataset
data(mtcars)

# Execute user code
${code}
`;
    }

    // Write R script to temp file
    await writeFile(scriptPath, rCode, 'utf8');

    // Execute R script using Rscript (doesn't echo commands)
    exec(`Rscript --vanilla "${scriptPath}"`, async (error, stdout, stderr) => {
      const result = {
        output: '',
        plots: [],
        tables: [],
        error: null
      };

      try {
        // Capture stdout/stderr (excluding "Plot generated successfully" message)
        if (stdout) {
          const cleanOutput = stdout.replace(/Plot generated successfully\n?/g, '').trim();
          if (cleanOutput) result.output += cleanOutput;
        }
        if (stderr && !stderr.includes('WARNING')) {
          result.output += '\n' + stderr;
        }

        // If there was an error, capture it
        if (error && error.code !== 0) {
          result.error = `R execution error: ${stderr || error.message}`;
        }

        // If plotting, read the SVG file
        if (hasPlot) {
          try {
            const { readFile } = await import('fs/promises');
            const svgContent = await readFile(svgPath, 'utf8');
            result.plots.push({
              type: 'image',
              data: svgContent
            });

            // Clean up SVG file
            await unlink(svgPath).catch(() => {});
          } catch (svgError) {
            console.error('Error reading SVG:', svgError);
            result.error = 'Plot generation failed';
          }
        }

        // Clean up script file
        await unlink(scriptPath).catch(() => {});

        res.json(result);
      } catch (cleanupError) {
        console.error('Error in cleanup:', cleanupError);
        res.json(result);
      }
    });

  } catch (error) {
    console.error('Error executing R code:', error);

    // Clean up files
    try {
      await unlink(scriptPath).catch(() => {});
      await unlink(svgPath).catch(() => {});
    } catch {}

    res.status(500).json({
      output: '',
      plots: [],
      tables: [],
      error: error.message || 'An error occurred while executing R code'
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📡 Ready to proxy requests to Anthropic API\n`);
  console.log(`🔧 R code execution endpoint available\n`);
});
