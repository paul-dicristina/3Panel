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
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import sharp from 'sharp';
import multer from 'multer';

const app = express();
const PORT = 3001;

// Get current directory (needed for ES modules)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Data folder path
const DATA_FOLDER = join(__dirname, 'data');

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, DATA_FOLDER);
  },
  filename: function (req, file, cb) {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage: storage });

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));  // Increase limit for base64 images
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// Serve widget HTML files from temp directory
app.use('/widgets', express.static(join(tmpdir(), '3panel-r-execution')));

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
    const { apiKey, messages, suggestionsEnabled, recentPlots } = req.body;

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
    let systemPrompt = `You are a helpful data analysis assistant. When users ask you to analyze data, load files, or create visualizations, you should:

1. Provide a brief conversational acknowledgment
2. Generate R code to accomplish the task
3. Wrap all R code in markdown code blocks with the 'r' language identifier

CRITICAL FORMATTING RULES:
- Keep your text response BRIEF and conversational (1-2 sentences maximum)
- Do NOT describe what the code does in detail - the code card will show that
- Do NOT explain the code output - users will see it in the output panel
- Do NOT include ANY data, numbers, statistics, or results in your text response
- Do NOT show dataset rows, summaries, or any computed values in your text
- NEVER print or display data outside of R code blocks
- Put ALL executable R code in code blocks
- Each code block should be complete and self-contained
- The R code will be executed automatically and results will appear in the output panel

CRITICAL - R WORKSPACE PERSISTENCE - READ CAREFULLY:
The R environment has PERSISTENT WORKSPACE across all code executions in the same conversation:

KEY RULES:
1. ALL variables, datasets, and objects persist automatically between code blocks
2. If the user loaded data in ANY previous message in this conversation, it STILL EXISTS in the workspace
3. BEFORE loading data, CHECK THE CONVERSATION HISTORY - if data was already loaded, DO NOT reload it
4. Libraries (ggplot2, dplyr, etc.) DO NOT persist - always call library() when needed
5. When analyzing data that was loaded earlier, just use the variable name directly

CORRECT workflow example:
User: "Load population data from URL into variable pop"
You: Generate code that loads: pop <- read.csv(url(...))

User: "Show me the first 20 rows"
You: Generate code: head(pop, 20)   <-- DO NOT reload pop, it exists!

User: "Create a plot of Canada's population"
You: Generate code: library(ggplot2); ggplot(subset(pop, Country.Name=="Canada"), ...)  <-- Use existing pop!

WRONG approach (DO NOT DO THIS):
User: "Create a plot of Canada's population"
You: pop <- read.csv(url(...))  <-- WRONG! Data already exists from earlier!

Check conversation history first. If data was loaded before, reuse it. Only load data if it's the FIRST time.

CRITICAL - AVOIDING DATASET CONFUSION:
When working with MULTIPLE datasets in the same conversation, be EXTREMELY CAREFUL not to confuse them:

1. PAY ATTENTION TO VARIABLE NAMES:
   - If the user says "examine lex.csv", work with the 'lex' variable
   - If the user says "examine pop", work with the 'pop' variable
   - DO NOT assume all datasets have the same structure or columns

2. ALWAYS SPECIFY WHICH DATASET YOU'RE WORKING WITH:
   Bad: "This dataset has columns X, Y, Z"
   Good: "The 'lex' dataset has columns X, Y, Z"

3. DO NOT MIX UP DATASETS:
   - If you just examined 'pop' and now the user asks about 'lex', DO NOT use column names from 'pop'
   - Each dataset is SEPARATE with its own structure
   - Always run str() or names() on the SPECIFIC dataset being asked about

4. WHEN SWITCHING DATASETS, START FRESH:
   - Don't carry over assumptions from the previous dataset
   - Check the structure of the NEW dataset explicitly
   - Use the correct variable name for the dataset being asked about

EXAMPLE OF CORRECT BEHAVIOR:
User: "Load pop.csv as pop and examine it"
You: pop <- read.csv('pop.csv'); str(pop)

User: "Now load lex.csv as lex and examine it"
You: lex <- read.csv('lex.csv'); str(lex)   <-- Use 'lex', not 'pop'!

User: "What columns does lex have?"
You: names(lex)   <-- Check LEX, not pop! They are DIFFERENT datasets!

WRONG BEHAVIOR (DO NOT DO THIS):
User: "What columns does lex have?"
You: [Responds with columns from 'pop' dataset]  <-- WRONG! This is dataset confusion!

CRITICAL - TRACKING DATASET TRANSFORMATIONS:
When a dataset is modified during a conversation, you MUST remember and work with the CURRENT state, not the original state.

1. REMEMBER TRANSFORMATIONS:
   - If column names were changed, use the NEW names
   - If columns were added/removed, work with the CURRENT structure
   - If data was filtered/transformed, the dataset reflects those changes

2. EXAMPLES OF CORRECT BEHAVIOR:
   User: "Remove the X prefix from lex column names"
   You: names(lex) <- sub("^X", "", names(lex))

   User: "Now pivot lex to long format"
   You: lex_long <- lex %>% pivot_longer(cols = -c(geo, name), ...)
   # CORRECT: Uses current column names WITHOUT the X prefix

3. WRONG BEHAVIOR (DO NOT DO THIS):
   User: "Remove the X prefix from lex column names"
   You: names(lex) <- sub("^X", "", names(lex))

   User: "Now pivot lex to long format"
   You: lex_long <- lex %>% pivot_longer(cols = starts_with("X"), ...)
   # WRONG: Assumes X prefix still exists when it was just removed!

4. WHEN IN DOUBT: Check the current state with str() or names() before generating transformation code.

Example response format:
"I'll create that visualization for you.

\`\`\`r
# Load the data
data <- read.csv('data.csv')

# Create scatter plot
library(ggplot2)
ggplot(data, aes(x=variable1, y=variable2)) +
  geom_point() +
  theme_minimal() +
  labs(title="Scatter Plot", x="Variable 1", y="Variable 2")
\`\`\`"

DATA ACCESS:
- The mtcars dataset is pre-loaded and available in all code
- The working directory is set to the 'data' folder in the project
- To load external CSV files, users must first place them in the 'data' folder
- Then use read.csv('filename.csv') to load them (no path needed)
- You can also use R's built-in datasets: iris, cars, ToothGrowth, PlantGrowth, etc.
- For remote data, you can use URLs: read.csv(url('https://example.com/data.csv'))

CRITICAL - WORKING WITH EXTERNAL DATA:
When working with external CSV files or URLs, you MUST follow this exact pattern:

Step 1: Load the data
Step 2: Print column names using names(dataframe) or str(dataframe)
Step 3: Use the EXACT column names from step 2 in your analysis

NEVER assume column names! R converts spaces to dots (e.g., "Country Name" → "Country.Name")

Example:
\`\`\`r
# Step 1: Load data
data <- read.csv(url('http://example.com/data.csv'))

# Step 2: Check actual column names
print(names(data))
print(str(data))

# Step 3: Use exact column names from step 2
# If names() shows "Country.Name", use that exactly:
result <- data %>% filter(Country.Name == "Canada")
\`\`\`

IMPORTANT: Include the names() or str() command in EVERY code block that loads external data!

CRITICAL - DATA QUALITY AND REASONING (MANDATORY):
Apply rigorous critical thinking and validation to ALL data analysis tasks. Think like a data scientist, not just a code generator.

FUNDAMENTAL PRINCIPLES:

1. EXPLORE BEFORE ANALYZING:
   Always examine what's actually in the data before performing analysis:
   \`\`\`r
   # Understand the data structure
   str(data)
   summary(data)

   # For categorical columns, check unique values
   cat("Unique values in key column:\\n")
   print(unique(data$category_column) %>% head(30))
   \`\`\`

2. QUESTION YOUR ASSUMPTIONS:
   Before filtering or grouping, ask yourself:
   - Does this dataset contain ONLY the entities the user is asking about?
   - Are there aggregate categories, totals, or special entries mixed in?
   - What makes sense to include or exclude given the user's question?

   Examples of common issues:
   - "Countries" datasets that also contain "World", "Regions", "Income groups"
   - "Customer" tables that include "Test User", "Unknown", "System"
   - "Product" data that includes "All Products", "Category Total"

3. VALIDATE YOUR RESULTS (MANDATORY - THIS IS THE MOST IMPORTANT STEP):
   After generating output, critically evaluate it BEFORE returning to the user:

   Ask yourself:
   - "Do these results make logical sense given the question?"
   - "Are there any obvious errors or nonsensical entries?"
   - "Would a domain expert spot problems with this?"

   Common red flags to check for:
   - Aggregate/summary rows in entity lists (e.g., "World" in a country list)
   - System/test entries in production data
   - Implausible values (negative counts, percentages > 100%)
   - Entities that don't match the category (e.g., "Early-demographic dividend" as a country)

   IF YOU SPOT ANY RED FLAGS: STOP. Revise your code to filter properly, then re-check.

4. BE EXPLICIT ABOUT DATA CLEANING:
   When you filter or clean data, explain what and why:
   \`\`\`r
   # Filtering to exclude aggregate categories that are mixed with individual entities
   cleaned_data <- data %>%
     filter(!grepl("total|all|aggregate|world|unknown", entity_column, ignore.case = TRUE))

   cat("Filtered from", nrow(data), "to", nrow(cleaned_data), "rows\\n")
   \`\`\`

   Tell the user: "I've removed [X type of entries] because they're [aggregate/test/etc] rather than [individual entities]."

5. HANDLE AMBIGUOUS REQUESTS:
   When the user's intent isn't crystal clear:
   - Examine the data to understand what's available
   - Make a reasonable inference
   - Be transparent about your assumption

   Example: "I notice this dataset contains both individual countries and regional groupings. Since you asked about 'countries', I've filtered to show only individual nations, excluding aggregates like 'World' or 'Middle income'."

6. USE COMMON SENSE AND DOMAIN KNOWLEDGE:
   Apply real-world knowledge to spot errors:
   - "World" is not a country - it's an aggregate
   - "Test User" or "Unknown" are not real customers
   - "All Products" is a category, not a product
   - Demographic/income classifications are not geographic entities

EXAMPLE OF RIGOROUS ANALYSIS:
\`\`\`r
# Step 1: Explore the data
cat("Sample of entity names in the dataset:\\n")
print(head(unique(data$entity_name), 25))

# Step 2: Identify potential issues
# I can see this includes both individual entities and aggregates/categories

# Step 3: Filter appropriately
filtered_data <- data %>%
  # Remove obvious aggregates (adapt patterns to your specific dataset)
  filter(!grepl("total|all|world|region|group|aggregate|average|unknown|test",
                entity_name, ignore.case = TRUE))

cat("\\nFiltered from", nrow(data), "to", nrow(filtered_data), "rows\\n")

# Step 4: Perform analysis
result <- filtered_data %>%
  arrange(desc(value)) %>%
  head(10)

# Step 5: Validate before returning
cat("\\nTop 10 results:\\n")
print(result$entity_name)
# Self-check: Do these all look like valid individual entities?
# If I see ANY aggregates, I need to improve my filtering.
\`\`\`

YOUR GOAL: Provide ACCURATE, THOUGHTFUL analysis - not just syntactically correct code. Always think critically about whether your results make sense!`;

    // Add suggestions instructions if enabled
    if (suggestionsEnabled) {
      systemPrompt += `

IMPORTANT: After providing your response and R code, if the user's request involved analyzing a specific dataset, you MUST include 4-5 suggestions for further analysis. Format these suggestions at the end of your response like this:

**Suggestions for further analysis:**
- Suggestion 1
- Suggestion 2
- Suggestion 3
- Suggestion 4
- Suggestion 5

CRITICAL REQUIREMENTS FOR SUGGESTIONS:
1. Base suggestions ONLY on columns/variables that have been explicitly shown or used in the conversation
2. Do NOT assume the dataset contains additional columns that weren't mentioned
3. If you're unsure what columns exist, suggest exploring the dataset structure first (e.g., "View column names and data types")
4. Focus on different analysis angles using the known columns (e.g., different visualizations, statistical tests, groupings, time periods)
5. If no dataset was referenced in the request, do NOT include suggestions`;
    }

    // Add vision instructions if plots are included
    if (recentPlots && recentPlots.length > 0) {
      systemPrompt += `

IMPORTANT: You can now SEE the plots that were generated! The user has included ${recentPlots.length} recent plot(s) with their message. You can analyze the visualizations and provide feedback on:
- Colors, styling, and aesthetics
- Data representation and clarity
- Suggestions for improvements
- Answering questions about what you see in the plot

When the user asks you to modify or improve a plot, you can see exactly what it looks like and make informed adjustments.`;
    }

    // Format messages with vision content blocks if plots are included
    let formattedMessages = messages;
    if (recentPlots && recentPlots.length > 0) {
      // Transform the last user message to include images
      formattedMessages = messages.map((msg, index) => {
        // Only modify the last user message
        if (msg.role === 'user' && index === messages.length - 1) {
          const contentBlocks = [];

          // Add plot images first
          for (const plot of recentPlots) {
            contentBlocks.push({
              type: 'image',
              source: {
                type: 'base64',
                media_type: 'image/png',
                data: plot.base64Data
              }
            });
            // Add a text label for the plot
            contentBlocks.push({
              type: 'text',
              text: `[Plot: ${plot.summary}]`
            });
          }

          // Add the user's message text
          contentBlocks.push({
            type: 'text',
            text: msg.content
          });

          return {
            role: msg.role,
            content: contentBlocks
          };
        }
        return msg;
      });
    }

    // Call Claude API
    // Using Claude 3 Opus - the most powerful model for best code generation
    const message = await anthropic.messages.create({
      model: 'claude-3-opus-20240229',
      max_tokens: 4096,
      system: systemPrompt,
      messages: formattedMessages
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
  const dataDir = join(process.cwd(), 'data'); // Use project's data directory
  const workspacePath = join(tempDir, 'workspace.RData'); // Persistent workspace
  const timestamp = Date.now();
  const scriptPath = join(tempDir, `script_${timestamp}.R`);
  const svgPath = join(tempDir, `plot_${timestamp}.svg`);
  const htmlPath = join(tempDir, `widget_${timestamp}.html`);

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

    console.log('=== R Code Execution ===');
    console.log('Has plot:', hasPlot);
    console.log('User code:', code.substring(0, 200));

    let rCode = code;

    // If plotting, wrap code to capture SVG
    if (hasPlot) {
      rCode = `
# Set CRAN mirror for package installation
options(repos = c(CRAN = "https://cloud.r-project.org"))

# Set working directory to data folder
setwd("${dataDir.replace(/\\/g, '/')}")

# Load previous workspace if it exists
if (file.exists("${workspacePath.replace(/\\/g, '/')}")) {
  load("${workspacePath.replace(/\\/g, '/')}")
}

# Load mtcars dataset
data(mtcars)

# Auto-load commonly used packages
suppressPackageStartupMessages({
  library(dplyr)
  library(ggplot2)
  library(tidyr)
  if (requireNamespace("maps", quietly = TRUE)) library(maps)
  if (requireNamespace("gt", quietly = TRUE)) library(gt)
})

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

# Save workspace for next execution
save.image("${workspacePath.replace(/\\/g, '/')}")

# Print success message
cat("Plot generated successfully\\n")
`;
    } else {
      // For non-plot code, load workspace, execute, and save
      rCode = `
# Set CRAN mirror for package installation
options(repos = c(CRAN = "https://cloud.r-project.org"))

# Set working directory to data folder
setwd("${dataDir.replace(/\\/g, '/')}")

# Load previous workspace if it exists
if (file.exists("${workspacePath.replace(/\\/g, '/')}")) {
  load("${workspacePath.replace(/\\/g, '/')}")
}

# Load mtcars dataset
data(mtcars)

# Auto-load commonly used packages
suppressPackageStartupMessages({
  library(dplyr)
  library(ggplot2)
  library(tidyr)
  if (requireNamespace("maps", quietly = TRUE)) library(maps)
  if (requireNamespace("gt", quietly = TRUE)) library(gt)
})

# Execute user code and check return value type first
.result <- withVisible({
  ${code}
})

.value <- .result$value
.visible <- .result$visible

# Check if result is an htmlwidget, formattable, or gt table
.is_widget <- FALSE
.widget_obj <- NULL
.is_gt <- FALSE

if (!is.null(.value)) {
  # Check if it's already an htmlwidget
  if (inherits(.value, "htmlwidget")) {
    .is_widget <- TRUE
    .widget_obj <- .value
  }
  # Check if it's a formattable object
  else if (inherits(.value, "formattable")) {
    if (requireNamespace("formattable", quietly = TRUE)) {
      .is_widget <- TRUE
      .widget_obj <- formattable::as.htmlwidget(.value)
    }
  }
  # Check if it's a gt table
  else if (inherits(.value, "gt_tbl")) {
    .is_gt <- TRUE
  }
  # Check if it has a knit_print method (other htmlwidget-like objects)
  else if (any(c("datatables", "DT") %in% class(.value))) {
    .is_widget <- TRUE
    .widget_obj <- .value
  }
}

# Handle gt tables, widgets, or regular output
if (.is_gt) {
  # gt tables output HTML directly, not as widgets
  if (requireNamespace("gt", quietly = TRUE)) {
    gt::gtsave(.value, "${htmlPath.replace(/\\/g, '/')}")
    cat("HTML_WIDGET_GENERATED\\n")
  }
} else if (.is_widget && !is.null(.widget_obj)) {
  # Save the widget and suppress automatic printing
  if (requireNamespace("htmlwidgets", quietly = TRUE)) {
    htmlwidgets::saveWidget(.widget_obj, "${htmlPath.replace(/\\/g, '/')}", selfcontained = FALSE)
    cat("HTML_WIDGET_GENERATED\\n")
  }
} else {
  # Not a widget - let it print normally if it was visible
  if (.visible && !is.null(.value)) {
    print(.value)
  }
}

# Save workspace for next execution
save.image("${workspacePath.replace(/\\/g, '/')}")
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
        // Capture stdout/stderr (excluding "Plot generated successfully" and "HTML_WIDGET_GENERATED" messages)
        if (stdout) {
          const cleanOutput = stdout
            .replace(/Plot generated successfully\n?/g, '')
            .replace(/HTML_WIDGET_GENERATED\n?/g, '')
            .trim();
          if (cleanOutput) result.output += cleanOutput;

          // Keep raw stdout for debugging
          console.log('Raw stdout:', stdout);
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
            console.log('Attempting to read SVG from:', svgPath);
            const { readFile, stat } = await import('fs/promises');

            // Check if SVG file exists
            try {
              const stats = await stat(svgPath);
              console.log('SVG file exists, size:', stats.size, 'bytes');

              // If SVG is empty or very small, there was likely an error
              if (stats.size < 100) {
                console.error('SVG file is empty or too small, likely an error occurred');
                result.error = stdout || 'Plot generation failed - empty output';
                // Clean up empty SVG file
                await unlink(svgPath).catch(() => {});
                return;
              }
            } catch (statError) {
              console.error('SVG file does not exist:', svgPath);
              result.error = 'Plot file was not created';
              return;
            }

            let svgContent = await readFile(svgPath, 'utf8');
            console.log('SVG content length:', svgContent.length);

            // Make SVG responsive by removing fixed width/height attributes
            // Keep viewBox for aspect ratio, remove width/height to allow CSS scaling
            svgContent = svgContent.replace(/<svg([^>]*)\swidth="[^"]*"/, '<svg$1');
            svgContent = svgContent.replace(/<svg([^>]*)\sheight="[^"]*"/, '<svg$1');

            // Convert SVG to PNG for Claude's vision
            let pngBase64 = null;
            try {
              const pngBuffer = await sharp(Buffer.from(svgContent))
                .png()
                .toBuffer();
              pngBase64 = pngBuffer.toString('base64');
              console.log('PNG conversion successful, base64 length:', pngBase64.length);
            } catch (conversionError) {
              console.error('Error converting SVG to PNG:', conversionError);
            }

            result.plots.push({
              type: 'image',
              data: svgContent,
              pngBase64: pngBase64  // Add base64 PNG for Claude's vision
            });

            // Clean up SVG file
            await unlink(svgPath).catch(() => {});
          } catch (svgError) {
            console.error('Error reading SVG:', svgError);
            result.error = 'Plot generation failed';
          }
        }

        // Check if HTML widget was generated
        if (stdout && stdout.includes('HTML_WIDGET_GENERATED')) {
          try {
            console.log('Attempting to read HTML widget from:', htmlPath);
            const { readFile, stat, readdir } = await import('fs/promises');
            const { dirname, basename, join } = await import('path');

            // Check if HTML file exists
            try {
              const stats = await stat(htmlPath);
              console.log('HTML file exists, size:', stats.size, 'bytes');
            } catch (statError) {
              console.error('HTML file does not exist:', htmlPath);
            }

            // Instead of inlining, serve the HTML file via Express
            const htmlFilename = basename(htmlPath);
            const widgetUrl = `/widgets/${htmlFilename}`;

            console.log('Widget URL:', widgetUrl);

            result.plots.push({
              type: 'html',
              url: widgetUrl
            });

            // Don't clean up the HTML file - it needs to be served
            // It will be cleaned up on next execution or server restart
          } catch (htmlError) {
            console.error('Error reading HTML widget:', htmlError);
          }
        }

        console.log('R execution stdout:', stdout);
        console.log('R execution stderr:', stderr);
        console.log('Result:', { hasPlots: result.plots.length, hasError: !!result.error });

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

/**
 * GET /api/check-file/:filename
 * Check if a file exists in the data folder
 */
app.get('/api/check-file/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const filePath = join(DATA_FOLDER, filename);

    const { access } = await import('fs/promises');
    await access(filePath);

    res.json({ exists: true, filename });
  } catch (error) {
    res.json({ exists: false, filename: req.params.filename });
  }
});

/**
 * POST /api/upload-data
 * Upload a data file to the data folder
 */
app.post('/api/upload-data', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log(`File uploaded: ${req.file.filename}`);
    res.json({
      success: true,
      filename: req.file.filename,
      path: req.file.path
    });
  } catch (error) {
    console.error('Error uploading file:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/clear-workspace
 * Clear the R workspace (for new conversations)
 */
app.post('/api/clear-workspace', async (req, res) => {
  try {
    const tempDir = join(tmpdir(), '3panel-r-execution');
    const workspacePath = join(tempDir, 'workspace.RData');

    // Delete workspace file if it exists
    await unlink(workspacePath).catch(() => {});

    console.log('R workspace cleared');
    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing workspace:', error);
    res.status(500).json({ error: error.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📡 Ready to proxy requests to Anthropic API\n`);
  console.log(`🔧 R code execution endpoint available\n`);
});
