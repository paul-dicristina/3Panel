/**
 * Backend Proxy Server
 *
 * This server proxies requests to the Anthropic API to avoid CORS issues
 * when calling the API directly from the browser
 */

import express from 'express';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { exec, spawn } from 'child_process';
import { writeFile, unlink, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
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

// Workspace paths
const TEMP_DIR = join(tmpdir(), '3panel-r-execution');
const TEMP_WORKSPACE = join(TEMP_DIR, 'workspace.RData');
const PERSISTENT_WORKSPACE = join(__dirname, '.r-workspace.RData'); // Permanent storage

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
 * Check if Quarto is installed and available
 * @returns {Promise<boolean>} True if Quarto is available
 */
function checkQuartoAvailable() {
  return new Promise((resolve) => {
    exec('quarto --version', (error, stdout, stderr) => {
      if (error) {
        console.log('Quarto not available:', error.message);
        resolve(false);
      } else {
        console.log('Quarto version:', stdout.trim());
        resolve(true);
      }
    });
  });
}

/**
 * Execute R code to save or load workspace
 * @param {string} rCode - R code to execute
 * @returns {Promise<void>}
 */
function executeRWorkspaceOperation(rCode) {
  return new Promise((resolve, reject) => {
    exec(`Rscript -e "${rCode}"`, (error, stdout, stderr) => {
      if (error) {
        console.error('R workspace operation error:', stderr || error.message);
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

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
    const { apiKey, messages, suggestionsEnabled, recentPlots, columnMetadata, activeDatasetName } = req.body;

    console.log('[/api/chat] Request received');
    console.log('[/api/chat] suggestionsEnabled:', suggestionsEnabled);
    console.log('[/api/chat] activeDatasetName:', activeDatasetName || 'none');
    console.log('[/api/chat] columnMetadata present:', !!columnMetadata);
    if (columnMetadata && columnMetadata.length > 0) {
      console.log('[/api/chat] columnMetadata preview:', columnMetadata.slice(0, 5).map(c => `${c.name}(${c.type})`).join(', '), `... (${columnMetadata.length} total)`);
      const hasYearColumn = columnMetadata.some(c => c.name === 'year');
      console.log('[/api/chat] Has "year" column:', hasYearColumn);
    }
    console.log('[/api/chat] messages count:', messages?.length);

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

    // Build column schema info if available
    let schemaInfo = '';
    if (columnMetadata && columnMetadata.length > 0) {
      const numericColumns = columnMetadata.filter(c => c.type === 'numeric').map(c => c.name);
      const categoricalColumnsWithValues = columnMetadata
        .filter(c => c.type === 'categorical' && c.values && c.values.length > 0)
        .map(c => `${c.name}: [${c.values.join(', ')}]`);

      const datasetNameInfo = activeDatasetName ? `\n🎯 ACTIVE DATASET: ${activeDatasetName}` : '';

      schemaInfo = `\n\nCURRENT DATASET SCHEMA:${datasetNameInfo}
Numeric columns: ${numericColumns.join(', ') || 'none'}
Categorical columns with values:
${categoricalColumnsWithValues.map(c => `  - ${c}`).join('\n') || 'none'}

🚨 CRITICAL DATASET VARIABLE NAME REQUIREMENT:
${activeDatasetName
  ? `When writing R code, you MUST use the exact variable name: ${activeDatasetName}
   DO NOT use generic names like "data", "df", or "dataset" - use "${activeDatasetName}" exactly!`
  : `A dataset exists but no active dataset name was provided. You MUST check the conversation history to find the exact variable name.
   NEVER use generic names like "data", "df", or "dataset" - find and use the EXACT variable name from when the dataset was loaded!`}

⚠️  CRITICAL: When writing R code that references column names, you MUST use the EXACT column names shown above.
DO NOT infer, guess, or fabricate column names. For example, if you see "TARGET: [Iris-setosa, ...]", the column name is TARGET, NOT "SPECIES" or any other name you might infer from the values.`;
    }

    // System prompt for data analysis assistant
    let systemPrompt = `You are a precise data analysis assistant. Answer ONLY what the user explicitly asks for.

CRITICAL - LITERAL INTERPRETATION:
- Do EXACTLY what the user requests - nothing more, nothing less
- If asked for "top 5", provide ONLY top 5 - NOT top 5 AND bottom 5
- Do NOT add "for context" sections unless explicitly requested
- Do NOT provide opposite comparisons unless asked (e.g., don't add bottom 5 when only top 5 was requested)
- Do NOT calculate summary statistics (averages, totals, counts) unless requested
- Do NOT add explanatory text or additional analyses beyond what was asked
- If the user wants more, they will ask for it

When users ask you to analyze data, load files, or create visualizations, you should:

1. Provide a brief conversational acknowledgment (1 sentence)
2. Generate R code to accomplish EXACTLY the requested task
3. Wrap all R code in markdown code blocks with the 'r' language identifier

CRITICAL FORMATTING RULES:
- Keep your text response BRIEF and conversational (1-2 sentences maximum)
- Do NOT describe what the code does in detail - the code card will show that
- Do NOT explain the code output - users will see it in the output panel
- Do NOT include ANY data, numbers, statistics, or results in your text response
- Do NOT show dataset rows, summaries, or any computed values in your text
- NEVER print or display data outside of R code blocks
- NEVER include R code, variable names, or function calls in your conversational text - ONLY in code blocks
- Put ALL executable R code in code blocks
- Each code block should be complete and self-contained
- The R code will be executed automatically and results will appear in the output panel
- Your conversational text should NEVER contain code blocks - they will be automatically extracted and shown separately

CRITICAL - R WORKSPACE PERSISTENCE - READ CAREFULLY:
The R environment has PERSISTENT WORKSPACE across all code executions in the same conversation:

KEY RULES:
1. ALL variables, datasets, and objects persist automatically between code blocks
2. If the user loaded data in ANY previous message in this conversation, it STILL EXISTS in the workspace
3. BEFORE loading data, CHECK THE CONVERSATION HISTORY - if data was already loaded, DO NOT reload it
4. Libraries (ggplot2, dplyr, etc.) DO NOT persist - always call library() when needed
5. When analyzing data that was loaded earlier, you MUST use the EXACT variable name from when it was loaded
   - DO NOT use generic names like "data", "df", or "dataset"
   - SCAN conversation history for the exact filename (e.g., "lex.csv")
   - USE the exact variable name (e.g., "lex") in your code

CRITICAL - SNOWFLAKE DATABASE CONNECTIONS:
A Snowflake helper file (snowflake_helper.R) is AUTOMATICALLY loaded with every R execution.
This file provides robust connection functions with automatic server format detection.

When the user asks to connect to Snowflake or query Snowflake data:
1. ALWAYS use snowflake_connect() to establish connection (NEVER use direct dbConnect calls)
2. The connection will try multiple server formats automatically and find the one that works
3. Once connected, credentials persist in the workspace for the entire conversation

AVAILABLE SNOWFLAKE FUNCTIONS (all pre-loaded and ready to use):
- snowflake_connect()                    - Connect with automatic format detection (use this FIRST)
- sf_databases()                         - List all available databases
- sf_tables()                            - List tables in current database/schema context
- sf_tables(database="DB")               - List ALL tables in a specific database (all schemas)
- sf_tables(schema="SCH")                - List tables in specific schema of current database
- sf_tables(database="DB", schema="SCH") - List tables in specific database.schema
- sf_preview("TABLE_NAME")               - Preview first 10 rows of a table
- sf_preview("TABLE_NAME", n=25)         - Preview first 25 rows
- sf_use(database="DB")                  - Switch to a different database
- sf_use(database="DB", schema="SCH")    - Switch database and schema
- sf_use(warehouse="WH")                 - Switch warehouse
- sf_query("SELECT * FROM ...")          - Execute any SQL query

EXAMPLE USAGE:
User: "Connect to Snowflake"
You generate:
\`\`\`r
snowflake_connect()
\`\`\`

User: "Show me the databases"
You generate:
\`\`\`r
sf_databases()
\`\`\`

User: "Query the customers table"
You generate:
\`\`\`r
customers <- sf_query("SELECT * FROM CUSTOMERS LIMIT 100")
head(customers)
\`\`\`

IMPORTANT NOTES:
- NEVER try to connect using dbConnect() directly. ALWAYS use snowflake_connect()
- Snowflake requires a warehouse to execute queries. The connection stores warehouse/database/schema context automatically
- If you get a "No active warehouse" error, use sf_use(warehouse="WAREHOUSE_NAME") to set one
- The helper automatically includes warehouse/database/schema in connections, so context persists across queries

⚠️⚠️⚠️ CRITICAL - DATASET VARIABLE NAMING CONVENTION ⚠️⚠️⚠️

🚨 ABSOLUTELY FORBIDDEN - NEVER USE THESE GENERIC VARIABLE NAMES:
- ❌ data
- ❌ df
- ❌ dataset
- ❌ my_data
- ❌ temp
- ❌ result

These names are BANNED. If you use them, your code WILL FAIL because the dataset doesn't exist under that name!

⚠️ MANDATORY REQUIREMENT:
When generating R code, you MUST use the EXACT dataset variable name from the conversation history.
DO NOT make up names. DO NOT use generic names. DO NOT assume names.

🔍 HOW TO FIND THE CORRECT VARIABLE NAME:

Step 1: SCAN the conversation history for when the dataset was loaded
Step 2: IDENTIFY the exact filename (e.g., "lex.csv", "Nutrition__Physical_Activity__and_Obesity_-_Behavioral_Risk_Factor_Surveillance_System.csv")
Step 3: APPLY the naming convention:
  - Remove the .csv extension
  - Replace ALL special characters (hyphens, spaces, dots, etc.) with underscores
  - Keep the exact case and structure
Step 4: USE that exact variable name in ALL your code

📋 NAMING CONVENTION EXAMPLES:
- "lex.csv" → variable is "lex"
- "population_data.csv" → variable is "population_data"
- "my-dataset.csv" → variable is "my_dataset" (hyphen becomes underscore)
- "Nutrition__Physical_Activity__and_Obesity_-_Behavioral_Risk_Factor_Surveillance_System.csv" → variable is "Nutrition__Physical_Activity__and_Obesity___Behavioral_Risk_Factor_Surveillance_System"

✅ CORRECT WORKFLOW:
User loads: "lex.csv"
System message: "Dataset 'lex' loaded with 3 columns..."
Variable is: lex

User asks: "Create a plot of life expectancy over time"
You generate: ggplot(lex, aes(x = year, y = life_expectancy)) + geom_line()  ← Uses "lex"!

✅ ANOTHER CORRECT EXAMPLE:
User loads: "Nutrition__Physical_Activity__and_Obesity_-_Behavioral_Risk_Factor_Surveillance_System.csv"
Variable is: Nutrition__Physical_Activity__and_Obesity___Behavioral_Risk_Factor_Surveillance_System

User asks: "Filter for obesity data"
You generate: obesity_data <- Nutrition__Physical_Activity__and_Obesity___Behavioral_Risk_Factor_Surveillance_System %>% filter(...)  ← Uses exact name!

❌ WRONG APPROACH (COMMON MISTAKES):
User loads: "lex.csv"
User asks: "Create a plot"
You generate: ggplot(data, aes(...))  ← WRONG! There is no variable called "data"!
You generate: ggplot(df, aes(...))  ← WRONG! There is no variable called "df"!
You generate: ggplot(dataset, aes(...))  ← WRONG! There is no variable called "dataset"!

❌ ANOTHER COMMON MISTAKE:
User loads: "Nutrition__Physical_Activity__and_Obesity_-_Behavioral_Risk_Factor_Surveillance_System.csv"
User asks: "Show obesity rates"
You generate: data %>% filter(...)  ← WRONG! You MUST use the full variable name!

🔄 REUSING EXISTING DATASETS:
User: "Load population data from URL into variable pop"
You: pop <- read.csv(url(...))

User: "Show me the first 20 rows"
You: head(pop, 20)   ← CORRECT! Reuses existing "pop" variable

User: "Create a plot of Canada's population"
You: ggplot(subset(pop, Country.Name=="Canada"), ...)  ← CORRECT! Uses existing "pop"!

❌ WRONG - DON'T RELOAD:
User: "Create a plot of Canada's population"
You: pop <- read.csv(url(...))  ← WRONG! Data already exists!

🎯 GOLDEN RULE:
Before writing ANY R code that references a dataset:
1. Check conversation history for the dataset load event
2. Find the exact filename
3. Convert to variable name using the naming convention
4. Use that EXACT name in your code
5. NEVER use generic names like "data", "df", or "dataset"

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

CRITICAL - DISPLAYING DATA IN R:
When the user asks to "show all rows" or "display the data", generate R code that works correctly:

CORRECT APPROACHES:
1. Just use the variable name by itself (most robust):
   \`\`\`r
   iris_data
   \`\`\`

2. Use as_tibble() to convert first, then print:
   \`\`\`r
   library(dplyr)
   as_tibble(iris_data)
   \`\`\`

3. Use head() with the actual row count:
   \`\`\`r
   head(iris_data, n = nrow(iris_data))
   \`\`\`

WRONG APPROACHES (DO NOT DO THESE):
- DO NOT use: print(iris_data, n = Inf)  ← This FAILS on regular data frames!
- DO NOT use: print(iris_data, n = 1000)  ← The 'n' parameter only works with tibbles!

EXPLANATION:
- The 'n' parameter in print() ONLY works with tibble objects (from dplyr/tibble packages)
- Regular data frames from read.csv(), sf_query(), and other sources will ERROR with 'n' parameter
- Using just the variable name invokes the default print method, which always works
- If you need to control row display, convert to tibble first with as_tibble()

EXAMPLES:
User: "show all rows of iris_data"
Correct: iris_data
Wrong: print(iris_data, n = Inf)

User: "display the customers data"
Correct: customers
Or: library(dplyr); as_tibble(customers)
Wrong: print(customers, n = Inf)

CRITICAL - DISPLAYING PLOTS IN R:
When creating ggplot2 visualizations, ALWAYS explicitly print the plot to ensure it displays:

CORRECT APPROACH - Explicit print():
\`\`\`r
library(ggplot2)
p <- ggplot(mtcars, aes(x=wt, y=mpg)) +
  geom_point() +
  theme_minimal()
print(p)  # ALWAYS print the plot!
\`\`\`

OR make the plot the LAST expression in the code block:
\`\`\`r
library(ggplot2)
# Do any data prep first
data_subset <- subset(mtcars, cyl == 6)

# Create and print plot as LAST expression
ggplot(data_subset, aes(x=wt, y=mpg)) +
  geom_point() +
  theme_minimal()
# Nothing after this!
\`\`\`

WRONG APPROACH - Plot not printed or code continues after plot:
\`\`\`r
library(ggplot2)
ggplot(mtcars, aes(x=wt, y=mpg)) + geom_point()  # Created but not printed
cat("Some text")  # This runs after, so plot doesn't display!
\`\`\`

WHY THIS MATTERS:
- In scripted R execution, ggplot objects must be explicitly printed or be the last expression
- If ANY code runs after creating the plot, it won't automatically display
- Always use print() or ensure the plot is the final expression

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

YOUR GOAL: Provide ACCURATE, THOUGHTFUL analysis - not just syntactically correct code. Always think critically about whether your results make sense!

CRITICAL - DATASET LOADING DIAGNOSTICS (MANDATORY):
Whenever you load a NEW dataset (whether via read.csv(), read.table(), file upload, or any data loading operation), your R code block MUST include comprehensive diagnostic commands:

REQUIRED R DIAGNOSTIC COMMANDS:
\`\`\`r
# Load the data
data <- read.csv('filename.csv')

# === MANDATORY DIAGNOSTIC SECTION - NEVER SKIP ===
cat("\\n=== DATASET DIAGNOSTICS ===\\n")
cat("Dimensions:", nrow(data), "rows x", ncol(data), "columns\\n")
cat("\\nColumn names:\\n")
print(names(data))
cat("\\nMissing values per column:\\n")
print(colSums(is.na(data)))
cat("\\nTotal missing values:", sum(is.na(data)), "out of", nrow(data) * ncol(data), "total cells\\n")

# Show structure and preview
cat("\\nData structure:\\n")
str(data)
cat("\\nFirst few rows:\\n")
print(head(data))

# === TIDY FORMAT ASSESSMENT ===
cat("\\nTidy format check:\\n")
# Check if column names look like values (years, categories, etc.)
potential_value_cols <- names(data)[grepl("^[0-9]{4}$|^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)", names(data))]
if(length(potential_value_cols) > 0) {
  cat("⚠️  Column names that appear to be values (suggest pivot_longer):", paste(potential_value_cols, collapse=", "), "\\n")
} else {
  cat("✓ Column names appear to be proper variable names\\n")
}
\`\`\`

CRITICAL RULES:
✓ ALWAYS include these diagnostic commands when loading new data
✓ The diagnostics will display complete information in the output panel
✓ Let the R output speak for itself - it shows the authoritative data structure

YOUR TEXT RESPONSE:
Keep your text response SHORT and SIMPLE. Do NOT report specific numbers, column names, or data details in your text - the R diagnostics will show everything.

Example text response:
"I've loaded the dataset. Please check the output panel above for complete diagnostics including dimensions, column names, missing data analysis, tidy format assessment, and data preview."

Then you may OPTIONALLY add 1-2 sentences about:
- What general subject area the data appears to cover (based on filename or general observation)
- What type of analysis might be interesting to explore

❌ DO NOT report specific row counts, column counts, or column names in your text
❌ DO NOT report missing data statistics in your text
❌ DO NOT guess or assume anything about the data structure in your text
✓ DO rely entirely on the R diagnostic output to show the user all details

IMPORTANT: This diagnostic requirement applies ONLY when LOADING data, not when working with already-loaded datasets.`;

    // Add suggestions instructions if enabled
    if (suggestionsEnabled) {
      systemPrompt += `

CRITICAL - SUGGESTIONS REQUIREMENT:
When a dataset is currently loaded and available in the workspace, you MUST include exactly 4 suggestions for further analysis after EVERY response that involves that dataset. This includes:
- Viewing data (head, tail, glimpse, summary, str, View, etc.)
- Analyzing data (calculations, statistics, models, etc.)
- Transforming data (filtering, mutating, pivoting, etc.)
- Visualizing data (plots, charts, graphs, etc.)

The ONLY time you should NOT include suggestions is for:
- General R help questions with no dataset involved
- Connection/setup tasks (loading libraries, connecting to databases)
- Questions about syntax or R programming concepts

Format suggestions at the end of your response like this:

**Suggestions for further analysis:**
- Suggestion 1
- Suggestion 2
- Suggestion 3
- Suggestion 4

CRITICAL REQUIREMENTS FOR SUGGESTIONS:
1. Each suggestion MUST be a complete, specific, prompt-ready statement that can be submitted directly without modification
2. Include EXACT variable/column names from the dataset (e.g., "mpg", "cyl", "am" - not vague references like "mileage variable" or "transmission type")
3. Reference the SPECIFIC dataset name (e.g., "mtcars", "iris", the loaded CSV filename)
4. Use imperative verbs with complete details (e.g., "Create a scatter plot of hp vs mpg from mtcars colored by cyl" NOT "Use color to represent a third variable")
5. Base suggestions ONLY on columns/variables that have been explicitly shown or used in the conversation
6. Do NOT assume the dataset contains additional columns that weren't mentioned
7. If you're unsure what columns exist, suggest exploring the dataset structure first (e.g., "Show column names and structure of mtcars")
8. WHEN TO PROVIDE SUGGESTIONS (READ THIS CAREFULLY):
   - If a dataset variable exists in the conversation history (e.g., mtcars, iris, a loaded CSV), you MUST provide suggestions for ANY request involving that dataset
   - This explicitly includes simple viewing commands like "head(dataset)", "show the first 10 rows", "display the data"
   - This includes ALL analytical operations, transformations, and visualizations
   - The ONLY exceptions are: pure R syntax questions, connection setup, or library loading with no dataset interaction
   - When in doubt, ALWAYS include suggestions if any dataset is mentioned or used in your R code

GOOD EXAMPLES OF SPECIFIC, ACTIONABLE SUGGESTIONS:
✓ "Create a scatter plot of hp vs mpg from mtcars with points colored by cyl"
✓ "Calculate correlation matrix for mpg, hp, wt, and qsec in mtcars"
✓ "Create a boxplot comparing mpg across different cyl groups in mtcars"
✓ "Filter mtcars for cars with hp > 150 and create a bar chart of cyl counts"

BAD EXAMPLES (TOO VAGUE):
✗ "Use color to represent a third variable like transmission type or number of gears"
✗ "Explore relationships between other variables"
✗ "Try a different visualization"
✗ "Analyze the data further"

===== CRITICAL - TIDY FORMAT SUGGESTION (MANDATORY FOR DATA LOADING) =====

WHEN THIS APPLIES:
This requirement ONLY applies when the user's request involved LOADING a NEW DATASET:
- Using read.csv(), read.table(), or similar data loading functions
- File upload via the load-data button
- First time working with a dataset in the conversation

DO NOT apply this when working with data that was already loaded earlier in the conversation.

STEP 1 - ASSESS THE DATA FORMAT:
When you load and display data, you MUST check if it follows tidy data principles:

TIDY DATA PRINCIPLES:
✓ Each variable forms a column
✓ Each observation forms a row
✓ Each type of observational unit forms a table

COMMON SIGNS OF NON-TIDY DATA:
✗ Column names are values (e.g., years "2000", "2001", "2002" as separate columns)
✗ Multiple variables encoded in one column name (e.g., "Male_18-24", "Female_18-24")
✗ Values spread across multiple columns when they should be in rows
✗ Multiple observational units in the same table

STEP 2 - IF DATA IS NOT TIDY, MAKE IT YOUR FIRST SUGGESTION:
Your FIRST suggestion MUST be a specific, actionable prompt to convert to tidy format.

REQUIRED FORMAT - Use the exact dataset name and be specific:
✓ "Convert [DATASET_NAME] to tidy format using pivot_longer() to reshape year columns into rows"
✓ "Transform [DATASET_NAME] from wide to long format using pivot_longer() on columns 2000 through 2023"

DO NOT use vague language:
✗ "Convert dataset to tidy format using pivot_longer() [or appropriate transformation]"
✗ "Consider tidying the data"

STEP 3 - IF DATA IS ALREADY TIDY:
Do NOT include a tidy format suggestion. Proceed with other analysis suggestions only.

===== END TIDY FORMAT REQUIREMENT =====

===== CRITICAL NAMING CONVENTION FOR TIDY TRANSFORMATIONS =====

When generating R code that converts data to tidy format (using pivot_longer, pivot_wider, gather, spread, etc.):

REQUIRED BEHAVIOR:
1. ALWAYS create a NEW dataset with "_tidy" appended to the original name
2. DO NOT overwrite the original dataset

CORRECT EXAMPLES:
✓ lex_tidy <- lex %>% pivot_longer(...)
✓ population_tidy <- population %>% pivot_longer(...)
✓ sales_tidy <- sales %>% pivot_wider(...)

WRONG EXAMPLES (DO NOT DO THIS):
✗ lex <- lex %>% pivot_longer(...)  # Overwrites original
✗ lex_long <- lex %>% pivot_longer(...)  # Use _tidy not _long
✗ tidy_lex <- lex %>% pivot_longer(...)  # Suffix, not prefix

This naming convention ensures:
- Original data is preserved for reference
- System can track the tidied dataset automatically
- Future code generation uses the correct tidied dataset
- Interactive suggestions use metadata from the tidied dataset

===== END NAMING CONVENTION =====`;
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

    // Add reactive components instructions to system prompt
    systemPrompt += `

INTERACTIVE REACTIVE COMPONENTS (Shiny-like interactivity):

You can create interactive visualizations that users can control WITHOUT requiring new LLM requests!

When appropriate (e.g., "create an interactive histogram" or "let me adjust the bin width"), output a reactive component spec in a JSON code block:

\`\`\`json
{
  "type": "reactive-component",
  "title": "Interactive Histogram",
  "description": "Adjust bin width to explore the distribution",
  "controls": [
    {
      "type": "slider",
      "param": "binwidth",
      "label": "Bin Width",
      "min": 0.1,
      "max": 5,
      "step": 0.1,
      "default": 1
    }
  ],
  "rCode": "library(ggplot2); ggplot(mtcars, aes(x=mpg)) + geom_histogram(binwidth={{binwidth}}) + theme_minimal()",
  "autoFormatTabular": false
}
\`\`\`

CONTROL TYPES:
- slider: {type: "slider", param: "name", min: 0, max: 100, step: 1, default: 50, label: "Label"}
- select: {type: "select", param: "name", options: ["opt1", "opt2"], default: "opt1", label: "Label"}
- checkbox: {type: "checkbox", param: "name", default: true, label: "Label"}
- text: {type: "text", param: "name", default: "value", placeholder: "hint", label: "Label"}

KEY POINTS:
- Use {{param}} in rCode to insert control values (e.g., {{binwidth}})
- The component will execute R code automatically when controls change
- No LLM round trip needed - instant updates!
- Use for: adjustable parameters, filtering, switching between views
- Keep it simple: 1-3 controls is ideal

EXAMPLE - Interactive Scatter Plot:
\`\`\`json
{
  "type": "reactive-component",
  "title": "Explore MPG vs Weight",
  "controls": [
    {
      "type": "slider",
      "param": "point_size",
      "label": "Point Size",
      "min": 1,
      "max": 10,
      "default": 3
    },
    {
      "type": "select",
      "param": "color_var",
      "label": "Color By",
      "options": ["cyl", "gear", "am"],
      "default": "cyl"
    }
  ],
  "rCode": "library(ggplot2); ggplot(mtcars, aes(x=wt, y=mpg, color=factor({{color_var}}))) + geom_point(size={{point_size}}) + theme_minimal() + labs(color={{color_var}})"
}
\`\`\`

WHEN TO USE:
- User asks for "interactive", "adjustable", or "let me control" features
- Parameters that make sense to tweak (binwidth, alpha, colors, filtering thresholds)
- Exploring different views of the same data

WHEN NOT TO USE:
- Simple static visualizations
- One-time analyses
- Complex multi-step workflows${schemaInfo}`;

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

    // Debug: Log messages before filtering
    console.log('\n=== BEFORE FILTERING ===');
    formattedMessages.forEach((msg, idx) => {
      console.log(`Message ${idx}:`, {
        role: msg.role,
        contentType: typeof msg.content,
        contentValue: Array.isArray(msg.content) ? `[Array of ${msg.content.length}]` : msg.content,
        isEmpty: !msg.content || (typeof msg.content === 'string' && msg.content.trim().length === 0)
      });
    });

    // Filter out messages with empty content (e.g., dataset report messages)
    formattedMessages = formattedMessages.filter(msg => {
      // For string content, check if it's non-empty
      if (typeof msg.content === 'string') {
        return msg.content.trim().length > 0;
      }
      // For array content (content blocks), check if array has items
      if (Array.isArray(msg.content)) {
        return msg.content.length > 0;
      }
      // Reject falsy content
      return false;
    });

    // Debug: Log messages after filtering
    console.log('\n=== AFTER FILTERING ===');
    formattedMessages.forEach((msg, idx) => {
      console.log(`Message ${idx}:`, {
        role: msg.role,
        contentType: typeof msg.content,
        contentValue: Array.isArray(msg.content) ? `[Array of ${msg.content.length}]` : msg.content
      });
    });
    console.log(`Total messages: ${formattedMessages.length}\n`);

    // Call Claude API
    // Using Claude Opus 4.5 - most capable model for code generation
    const message = await anthropic.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 4096,
      system: systemPrompt,
      messages: formattedMessages
    });

    // Extract and parse suggestions if they exist
    let parsedSuggestions = null;
    if (suggestionsEnabled && message.content && message.content[0] && message.content[0].text) {
      const responseText = message.content[0].text;
      console.log('[/api/chat] Checking for suggestions in response...');
      console.log('[/api/chat] Response text preview:', responseText.substring(0, 200));
      const suggestionsMatch = responseText.match(/\*\*Suggestions for further analysis:\*\*\s*([\s\S]*?)(?:\n\n|$)/);

      if (suggestionsMatch) {
        console.log('[/api/chat] Found suggestions section in response');

        const suggestionsText = suggestionsMatch[1];
        const suggestionLines = suggestionsText
          .split('\n')
          .filter(line => line.trim().startsWith('-'))
          .map(line => line.replace(/^-\s*/, '').trim())
          .filter(s => s.length > 0);

        // Convert to suggestion objects
        parsedSuggestions = suggestionLines.map(text => ({ text }));

        // Initialize interactives array for each suggestion
        for (const sug of parsedSuggestions) {
          sug.interactives = [];
        }

        console.log('[/api/chat] Extracted', parsedSuggestions.length, 'suggestions from response');

        // Add interactive elements if we have column metadata
        if (columnMetadata && columnMetadata.length > 0) {
          console.log('[/api/chat] Adding interactive elements using column metadata');

          // Get categorical columns sorted by priority (prefer longer, more descriptive names)
          const categoricalColumns = columnMetadata
            .filter(col => col.type === 'categorical' && col.values && col.values.length > 0)
            .sort((a, b) => {
              // Prefer "name" column over others
              if (a.name === 'name') return -1;
              if (b.name === 'name') return 1;
              // Then prefer longer column names (more descriptive)
              return b.name.length - a.name.length;
            });

          console.log('[/api/chat] Categorical columns in priority order:', categoricalColumns.map(c => c.name));

          // Blacklist of common English words to exclude from interactive matching
          // Even if these are valid data values, making them interactive is confusing
          const commonWordBlacklist = new Set([
            'and', 'or', 'in', 'to', 'for', 'the', 'a', 'an', 'of', 'at', 'by', 'with',
            'from', 'on', 'as', 'is', 'was', 'are', 'be', 'been', 'being', 'have', 'has',
            'had', 'do', 'does', 'did', 'will', 'would', 'could', 'should', 'may', 'might',
            'can', 'about', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
            'up', 'down', 'out', 'over', 'under', 'again', 'further', 'then', 'once'
          ]);

          // Process each suggestion to add interactive elements
          for (const sug of parsedSuggestions) {
            let bestMatch = null;

            // Try each categorical column in priority order
            for (const col of categoricalColumns) {
              // Sort values by length (longest first) to match longer names before shorter ones
              const sortedValues = [...col.values].sort((a, b) => b.length - a.length);

              for (const value of sortedValues) {
                // Skip common English words and very short values (likely codes, not names)
                const valueLower = value.toLowerCase();
                if (commonWordBlacklist.has(valueLower) || value.length < 4) {
                  continue;
                }

                // Use word boundary regex to avoid substring matches
                // Match the value as a whole word (not part of another word)
                const regex = new RegExp(`\\b${value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'ig');
                let match;

                // Find all matches of this value
                while ((match = regex.exec(sug.text)) !== null) {
                  const valueIndex = match.index;
                  const matchedValue = match[0];

                  // === SEMANTIC FILTERING: Check if this match is truly interactive ===

                  const beforeMatch = sug.text.substring(Math.max(0, valueIndex - 50), valueIndex);
                  const afterMatch = sug.text.substring(valueIndex + matchedValue.length, Math.min(sug.text.length, valueIndex + matchedValue.length + 50));
                  const contextBefore = sug.text.substring(Math.max(0, valueIndex - 80), valueIndex);
                  const fullContext = sug.text.substring(Math.max(0, valueIndex - 100), Math.min(sug.text.length, valueIndex + matchedValue.length + 100));

                  // 1. Check if value is in parentheses with other values (explanatory list)
                  const inParenList = beforeMatch.includes('(') && !beforeMatch.includes(')') &&
                                     (afterMatch.includes(',') || beforeMatch.includes(','));

                  if (inParenList) {
                    console.log(`[/api/chat] Skipping "${matchedValue}" - in parenthetical list (explanatory)`);
                    continue;
                  }

                  // 2. Detect GROUP BY / aggregation operations (showing ALL categories, not filtering to one)
                  const groupByPattern = /\b(by|across|among|between)\s+(\w+\s+)?(categories?|types?|groups?|statuses?|stages?)\b/i;
                  const isGroupByOperation = groupByPattern.test(contextBefore);

                  if (isGroupByOperation) {
                    console.log(`[/api/chat] Skipping "${matchedValue}" - part of GROUP BY operation (showing all categories)`);
                    continue;
                  }

                  // 3. Check for aggregation verbs followed by "by COLUMN" pattern
                  const aggregationByPattern = /\b(count|sum|average|mean|median|group|plot|chart|compare|show|visualize)\s+.*?\s+by\s+\w+/i;
                  if (aggregationByPattern.test(contextBefore)) {
                    console.log(`[/api/chat] Skipping "${matchedValue}" - part of aggregation BY clause (showing all values)`);
                    continue;
                  }

                  // 4. REMOVED: Low cardinality filter was too aggressive
                  // Lists like "USA, China, and India" SHOULD have interactive elements for each country
                  // Users benefit from being able to swap out individual countries in comparative analyses

                  // 5. Check if multiple values from same column appear together in a list
                  // Allow individual interactive elements for each value in a comparative list
                  // Only skip if this is clearly a "showing all values" scenario (e.g., "group by country")
                  // Lists like "Japan, USA, and UK" should have each country be interactive

                  // Skip this check - we want each value to be interactive even in lists
                  // This allows users to swap out individual items from comparative analyses

                  // 6. Look for FILTERING prepositions that indicate a choice (for, where, with specific)
                  // These indicate we're selecting ONE subset, not showing all
                  const filteringPattern = /\b(for|where|focusing on|limited to|only|specific|particular)\s+[\w\s]{0,20}$/i;
                  const hasFilteringContext = filteringPattern.test(contextBefore);

                  // 7. Check for strong aggregation/grouping language that shows ALL values
                  // But allow interactive elements for comparative lists (e.g., "plot Japan, USA, UK")
                  const strongAggregationPattern = /\b(group\s+by|across\s+all|for\s+each|distribution\s+by)\b/i;
                  const isStrongAggregation = strongAggregationPattern.test(contextBefore);

                  if (isStrongAggregation && !hasFilteringContext) {
                    console.log(`[/api/chat] Skipping "${matchedValue}" - has strong aggregation language (showing all values)`);
                    continue;
                  }

                  // This match passed all semantic filters - it's truly interactive
                  // Keep track of the best match (prefer earlier matches, then from priority columns)
                  if (!bestMatch || valueIndex < bestMatch.index) {
                    bestMatch = {
                      value: matchedValue,  // Use actual matched text (preserves case)
                      column: col,
                      index: valueIndex
                    };
                  }
                }
              }

              // If we found a match in this priority column, use it
              if (bestMatch) break;
            }

            // Apply the best match if found
            if (bestMatch) {
              sug.interactives.push({
                value: bestMatch.value,
                context: `Select ${bestMatch.column.name}`,
                options: [...bestMatch.column.values].sort(),
                start: bestMatch.index,
                end: bestMatch.index + bestMatch.value.length
              });

              console.log(`[/api/chat] Made suggestion interactive with value "${bestMatch.value}" from column ${bestMatch.column.name}`);

              // Only keep first 2 interactive elements
              if (sug.interactives.length >= 2) break;
            }
          }
        }

        // Add numeric sliders for suggestions that don't already have interactive elements
        console.log('[/api/chat] Checking for numeric values to make interactive...');
        for (const sug of parsedSuggestions) {
          // Check if Claude provided explicit numeric range with column specification
          if (sug.interactive && sug.interactive.type === 'numeric-range') {
            // Claude explicitly specified the column - use it!
            const { column, minValue, maxValue } = sug.interactive;

            // Validate column exists in metadata
            const matchedColumn = columnMetadata.find(col =>
              col.type === 'numeric' && col.name === column
            );

            if (matchedColumn) {
              // Find the range text in the suggestion to calculate positions
              const rangePatterns = [
                new RegExp(`\\b(?:from\\s+)?${minValue}\\s+(?:to|through)\\s+${maxValue}\\b`, 'i'),
                new RegExp(`\\bbetween\\s+${minValue}\\s+and\\s+${maxValue}\\b`, 'i'),
                new RegExp(`\\b${minValue}\\s*-\\s*${maxValue}\\b`)
              ];

              let rangeMatch = null;
              for (const pattern of rangePatterns) {
                const match = sug.text.match(pattern);
                if (match) {
                  rangeMatch = match;
                  break;
                }
              }

              if (rangeMatch) {
                const columnName = matchedColumn.name.charAt(0).toUpperCase() + matchedColumn.name.slice(1);

                sug.interactive = {
                  type: 'year-range',  // Use year-range type for dual-thumb slider
                  context: `${columnName} Range`,
                  minValue: minValue,
                  maxValue: maxValue,
                  min: Math.floor(matchedColumn.min),
                  max: Math.ceil(matchedColumn.max),
                  step: Number.isInteger(matchedColumn.min) && Number.isInteger(matchedColumn.max) ? 1 : 0.1,
                  start: rangeMatch.index,
                  end: rangeMatch.index + rangeMatch[0].length
                };

                console.log(`[/api/chat] ✓ Made numeric range slider from Claude's specification: column="${column}", range=${minValue}-${maxValue}`);
                continue; // Move to next suggestion
              } else {
                console.log(`[/api/chat] ✗ Claude specified numeric range but couldn't find range text in suggestion`);
              }
            } else {
              console.log(`[/api/chat] ✗ Claude specified column "${column}" but it doesn't exist in metadata or isn't numeric`);
            }
          }

          // Skip if already has 2 interactive elements
          if (sug.interactives.length >= 2) continue;

          // FALLBACK: Try to guess numeric range from text (old behavior)
          // Patterns like "25 to 65", "1950-1990", "from 10 to 100", "between 0 and 50"
          // Works with ANY numeric range, not just years
          const numericRangePatterns = [
            /\b(?:from\s+)?(\d+(?:\.\d+)?)\s+(?:to|through)\s+(\d+(?:\.\d+)?)\b/i,
            /\bbetween\s+(\d+(?:\.\d+)?)\s+and\s+(\d+(?:\.\d+)?)\b/i,
            /\b(\d{3,})\s*-\s*(\d{3,})\b/  // Hyphen for larger numbers (avoid matching "2-3" as range)
          ];

          let rangeMatch = null;

          for (const pattern of numericRangePatterns) {
            const match = sug.text.match(pattern);
            if (match) {
              rangeMatch = match;
              break;
            }
          }

          if (rangeMatch && columnMetadata && columnMetadata.length > 0) {
            const value1 = parseFloat(rangeMatch[1]);
            const value2 = parseFloat(rangeMatch[2]);
            const rangeIndex = rangeMatch.index;
            const rangeText = rangeMatch[0];

            // Get context around the range to find column name
            const contextStart = Math.max(0, rangeIndex - 50);
            const contextEnd = Math.min(sug.text.length, rangeIndex + rangeText.length + 20);
            const context = sug.text.substring(contextStart, contextEnd).toLowerCase();

            // Try to find which numeric column this range belongs to
            const numericColumns = columnMetadata.filter(col =>
              col.type === 'numeric' && col.min !== undefined && col.max !== undefined
            );

            let matchedColumn = null;

            // Strategy 1: Look for explicit column name mention
            for (const col of numericColumns) {
              if (context.includes(col.name.toLowerCase())) {
                matchedColumn = col;
                console.log(`[/api/chat] Matched range to column "${col.name}" via name mention`);
                break;
              }
            }

            // Strategy 2: Check if range values fall within any column's bounds
            if (!matchedColumn) {
              for (const col of numericColumns) {
                const minVal = Math.min(value1, value2);
                const maxVal = Math.max(value1, value2);
                if (minVal >= col.min && maxVal <= col.max) {
                  matchedColumn = col;
                  console.log(`[/api/chat] Matched range "${rangeText}" to column "${col.name}" via value range`);
                  break;
                }
              }
            }

            if (matchedColumn) {
              const columnName = matchedColumn.name.charAt(0).toUpperCase() + matchedColumn.name.slice(1);

              sug.interactives.push({
                type: 'year-range',  // Keeping same type for dual-thumb slider
                context: `${columnName} Range`,
                minValue: Math.min(value1, value2),
                maxValue: Math.max(value1, value2),
                min: Math.floor(matchedColumn.min),
                max: Math.ceil(matchedColumn.max),
                step: Number.isInteger(matchedColumn.min) && Number.isInteger(matchedColumn.max) ? 1 : 0.1,
                start: rangeIndex,
                end: rangeIndex + rangeText.length
              });

              console.log(`[/api/chat] Made numeric range slider for "${rangeText}" on column "${matchedColumn.name}" (${matchedColumn.min}-${matchedColumn.max})`);
              continue; // Move to next suggestion
            }
          }

          // Look for SINGLE NUMERIC values that reference dataset columns
          // Only make them interactive if we can confidently match to a column
          if (columnMetadata && columnMetadata.length > 0) {
            const numericColumns = columnMetadata.filter(col =>
              col.type === 'numeric' && col.min !== undefined && col.max !== undefined
            );

            if (numericColumns.length > 0) {
              // Look for single numeric values - try both integers and decimals
              const numericPatterns = [
                /\b(\d{3,}(?:\.\d+)?)\b/,  // 3+ digit numbers (years, IDs, prices)
                /\b(\d{1,2}(?:\.\d+)?)\b/   // 1-2 digit numbers (ages, scores, small values)
              ];

              for (const pattern of numericPatterns) {
                const numMatch = sug.text.match(pattern);
                if (!numMatch) continue;

                const numericValue = numMatch[1];
                const numValue = parseFloat(numericValue);
                const valueIndex = numMatch.index;

                // Get context around the value to find column name
                const contextStart = Math.max(0, valueIndex - 40);
                const contextEnd = Math.min(sug.text.length, valueIndex + numericValue.length + 40);
                const context = sug.text.substring(contextStart, contextEnd).toLowerCase();

                let matchedColumn = null;

                // Strategy 1: Look for explicit column name mention near the value
                for (const col of numericColumns) {
                  const colNameLower = col.name.toLowerCase();
                  if (context.includes(colNameLower)) {
                    // Value should be within column's range
                    if (numValue >= col.min && numValue <= col.max) {
                      matchedColumn = col;
                      console.log(`[/api/chat] Matched value "${numericValue}" to column "${col.name}" via name mention`);
                      break;
                    }
                  }
                }

                // Strategy 2: For 4-digit numbers, try year-like columns
                if (!matchedColumn && /^\d{4}$/.test(numericValue)) {
                  matchedColumn = numericColumns.find(col =>
                    /year|yr|date|time/i.test(col.name) &&
                    numValue >= col.min && numValue <= col.max
                  );
                  if (matchedColumn) {
                    console.log(`[/api/chat] Matched 4-digit value "${numericValue}" to column "${matchedColumn.name}"`);
                  }
                }

                // Create interactive element if we found a confident match
                if (matchedColumn) {
                  const columnName = matchedColumn.name.charAt(0).toUpperCase() + matchedColumn.name.slice(1);

                  sug.interactives.push({
                    type: 'slider',
                    context: columnName,
                    min: Math.floor(matchedColumn.min),
                    max: Math.ceil(matchedColumn.max),
                    step: Number.isInteger(matchedColumn.min) && Number.isInteger(matchedColumn.max) ? 1 : 0.1,
                    start: valueIndex,
                    end: valueIndex + numericValue.length
                  });

                  console.log(`[/api/chat] Made numeric slider for "${numericValue}" (${matchedColumn.name}: ${matchedColumn.min}-${matchedColumn.max})`);
                  // Removed break - allow up to 2 interactive elements
                }
              }
            }
          }
        }
      } else {
        console.log('[/api/chat] No suggestions section found in response');
      }
    } else {
      console.log('[/api/chat] Skipping suggestion extraction (suggestionsEnabled:', suggestionsEnabled, ')');
    }

    // Add backwards compatibility - maintain old .interactive field for single elements
    if (parsedSuggestions && parsedSuggestions.length > 0) {
      for (const sug of parsedSuggestions) {
        // Limit to 2 elements max (safety check)
        if (sug.interactives && sug.interactives.length > 2) {
          sug.interactives = sug.interactives.slice(0, 2);
        }

        // Keep old format for single element (backwards compatibility)
        if (sug.interactives && sug.interactives.length === 1) {
          sug.interactive = sug.interactives[0];
        }
        // For 2 elements, only use new format (no .interactive field)
      }
    }

    // Return the response with parsed suggestions
    const response = {
      success: true,
      data: message
    };

    if (parsedSuggestions && parsedSuggestions.length > 0) {
      response.suggestions = parsedSuggestions;
    }

    res.json(response);

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

    if (error.status === 529) {
      return res.status(529).json({
        error: 'Claude API is currently overloaded. Please wait a moment and try again.'
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
    const {
      code,
      autoFormatTabular = true,
      refreshMetadata = false,  // Whether to refresh metadata after execution
      activeDataset = 'data'     // Which dataset to refresh metadata for
    } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        error: 'R code is required'
      });
    }

    console.log('Auto format tabular:', autoFormatTabular);
    console.log('Refresh metadata:', refreshMetadata, 'for dataset:', activeDataset);

    // Try to detect which dataset was actually created/modified by parsing the R code
    // Look for assignment operations like: variable_name <- ...
    // Handle various patterns: at start of line, with whitespace, or in pipe chains
    let detectedDataset = activeDataset;
    if (refreshMetadata) {
      // Try multiple patterns to detect dataset assignment
      const patterns = [
        /^(\w+)\s*<-/m,                           // Start of line: dataset <- ...
        /^\s*(\w+)\s*<-/m,                         // With leading whitespace: dataset <- ...
        /(?:^|[;\n])\s*(\w+)\s*<-\s*\w+\s*%>%/m,  // Pipe chain: dataset <- data %>% ...
      ];

      for (const pattern of patterns) {
        const match = code.match(pattern);
        if (match) {
          detectedDataset = match[1];
          console.log(`[DATASET DETECTION] Detected assignment to '${detectedDataset}' from R code`);
          break;
        }
      }

      // If no match, log for debugging
      if (detectedDataset === activeDataset) {
        console.log(`[DATASET DETECTION] No dataset assignment detected, using activeDataset: ${activeDataset}`);
        // Try to show first 200 chars of code for debugging
        console.log(`[DATASET DETECTION] Code preview: ${code.substring(0, 200)}`);
      }
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

# Source Snowflake helper if it exists
if (file.exists("snowflake_helper.R")) {
  suppressMessages(source("snowflake_helper.R"))
}

# Auto-load commonly used packages
suppressPackageStartupMessages({
  library(dplyr)
  library(ggplot2)
  library(tidyr)
  library(tibble)
  library(scales)
  if (requireNamespace("maps", quietly = TRUE)) library(maps)
  if (requireNamespace("gt", quietly = TRUE)) library(gt)
  if (requireNamespace("plotly", quietly = TRUE)) library(plotly)
  if (requireNamespace("gganimate", quietly = TRUE)) library(gganimate)
  if (requireNamespace("leaflet", quietly = TRUE)) library(leaflet)
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

# Source Snowflake helper if it exists
if (file.exists("snowflake_helper.R")) {
  suppressMessages(source("snowflake_helper.R"))
}

# Auto-load commonly used packages
suppressPackageStartupMessages({
  library(dplyr)
  library(ggplot2)
  library(tidyr)
  library(tibble)
  library(scales)
  if (requireNamespace("maps", quietly = TRUE)) library(maps)
  if (requireNamespace("gt", quietly = TRUE)) library(gt)
  if (requireNamespace("plotly", quietly = TRUE)) library(plotly)
  if (requireNamespace("gganimate", quietly = TRUE)) library(gganimate)
  if (requireNamespace("leaflet", quietly = TRUE)) library(leaflet)
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
  # Auto-format tabular data with gt if enabled
  ${autoFormatTabular ? `
  if ((is.data.frame(.value) || inherits(.value, "tbl_df") || inherits(.value, "tibble")) &&
      !inherits(.value, "gt_tbl") &&
      !inherits(.value, "htmlwidget") &&
      requireNamespace("gt", quietly = TRUE)) {
    .value <- gt::gt(.value)
    .is_gt <- TRUE
  }
  ` : ''}

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

        // Refresh metadata if requested
        if (refreshMetadata && !result.error) {
          try {
            console.log(`[METADATA REFRESH] Refreshing metadata for dataset: ${detectedDataset}`);

              // Check if dataset exists
              const checkCode = `exists("${detectedDataset}")`;
            const checkScriptPath = join(tempDir, `check_${timestamp}.R`);
            const checkWrapperCode = `
# Set working directory to data folder
setwd("${dataDir.replace(/\\/g, '/')}")

# Load workspace if it exists
if (file.exists("${workspacePath.replace(/\\/g, '/')}")) {
  load("${workspacePath.replace(/\\/g, '/')}")
}

cat(${checkCode})
`;

            await writeFile(checkScriptPath, checkWrapperCode, 'utf8');
            const checkResult = await new Promise((resolve) => {
              exec(`Rscript --vanilla "${checkScriptPath}"`, (err, stdout) => {
                resolve(stdout.trim() === 'TRUE');
              });
            });
            await unlink(checkScriptPath).catch(() => {});

            if (checkResult) {
              // Dataset exists, get updated metadata
              const metadataCode = `
# Check if dataset exists and is valid
if (!exists("${detectedDataset}") || is.null(${detectedDataset})) {
  list(
    error = "Dataset does not exist or is NULL",
    ncol = 0,
    nrow = 0,
    colnames = character(0),
    categoricalInfo = list(),
    numericCols = character(0)
  )
} else {
  # Analyze categorical columns
  categorical_info <- list()
  numeric_cols <- c()
  numeric_info <- list()

  for (col_name in names(${detectedDataset})) {
    col_data <- ${detectedDataset}[[col_name]]

    if (is.factor(col_data) || is.character(col_data)) {
      n_unique <- length(unique(na.omit(col_data)))
      if (n_unique >= 2 && n_unique <= 250) {
        unique_vals <- sort(unique(na.omit(col_data)))
        categorical_info[[col_name]] <- unique_vals
      }
    } else if (is.numeric(col_data)) {
      numeric_cols <- c(numeric_cols, col_name)
      # Calculate min/max for numeric columns
      clean_data <- na.omit(col_data)
      if (length(clean_data) > 0) {
        numeric_info[[col_name]] <- list(
          min = min(clean_data),
          max = max(clean_data)
        )
      }
    }
  }

  # Return structure info
  list(
    ncol = ncol(${detectedDataset}),
    nrow = nrow(${detectedDataset}),
    colnames = names(${detectedDataset}),
    categoricalInfo = categorical_info,
    numericCols = numeric_cols,
    numericInfo = numeric_info
  )
}
`;

              const metadataScriptPath = join(tempDir, `metadata_${timestamp}.R`);
              const metadataWrapperCode = `
# Set working directory to data folder
setwd("${dataDir.replace(/\\/g, '/')}")

# Load workspace if it exists
if (file.exists("${workspacePath.replace(/\\/g, '/')}")) {
  load("${workspacePath.replace(/\\/g, '/')}")
}

suppressPackageStartupMessages({
  library(jsonlite)
})

result <- ${metadataCode}
cat(toJSON(result, auto_unbox = TRUE))
`;

              await writeFile(metadataScriptPath, metadataWrapperCode, 'utf8');

              const metadataResult = await new Promise((resolve, reject) => {
                exec(`Rscript --vanilla "${metadataScriptPath}"`, (err, stdout, stderr) => {
                  if (err) {
                    console.error('[METADATA REFRESH] Error:', stderr);
                    reject(err);
                  } else {
                    try {
                      // Extract JSON from stdout (may contain other output before the JSON)
                      let jsonStr = stdout.trim();

                      // Try to find JSON object boundaries
                      const firstBrace = jsonStr.indexOf('{');
                      const lastBrace = jsonStr.lastIndexOf('}');

                      if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
                        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
                      }

                      const parsed = JSON.parse(jsonStr);
                      // Log what we got from R
                      console.log('[METADATA REFRESH] Parsed result - numericCols:', parsed.numericCols?.length || 0, 'numericInfo keys:', Object.keys(parsed.numericInfo || {}).length);
                      resolve(parsed);
                    } catch (parseErr) {
                      console.error('[METADATA REFRESH] Parse error:', parseErr);
                      console.error('[METADATA REFRESH] Stdout was:', stdout);
                      // Don't reject - just resolve with empty metadata
                      resolve({
                        ncol: 0,
                        nrow: 0,
                        colnames: [],
                        categoricalInfo: {},
                        numericCols: []
                      });
                    }
                  }
                });
              });

              await unlink(metadataScriptPath).catch(() => {});

              // Check if metadata retrieval had an error
              if (metadataResult.error) {
                console.log(`[METADATA REFRESH] ${metadataResult.error}`);
              } else if (metadataResult.colnames && metadataResult.colnames.length > 0) {
                // Build columnMetadata array
                const columnMetadata = [];

                for (const colName of metadataResult.colnames) {
                  if (metadataResult.categoricalInfo && metadataResult.categoricalInfo[colName]) {
                    columnMetadata.push({
                      name: colName,
                      type: 'categorical',
                      values: metadataResult.categoricalInfo[colName]
                    });
                  } else if (metadataResult.numericCols && metadataResult.numericCols.includes(colName)) {
                    const numericMeta = {
                      name: colName,
                      type: 'numeric'
                    };
                    // Add min/max if available
                    if (metadataResult.numericInfo && metadataResult.numericInfo[colName]) {
                      numericMeta.min = metadataResult.numericInfo[colName].min;
                      numericMeta.max = metadataResult.numericInfo[colName].max;
                    }
                    columnMetadata.push(numericMeta);
                  } else {
                    columnMetadata.push({
                      name: colName,
                      type: 'other'
                    });
                  }
                }

                // Add metadata to result
                // Check if this is a tidy dataset that should become the new active dataset
                const isTidyDataset = detectedDataset.endsWith('_tidy');

                result.updatedMetadata = {
                  datasetName: detectedDataset,
                  columnMetadata: columnMetadata,
                  shouldBecomeActive: isTidyDataset,  // Auto-switch to tidy datasets
                  hash: JSON.stringify({
                    ncol: metadataResult.ncol,
                    nrow: metadataResult.nrow,
                    columns: metadataResult.colnames
                  })
                };

                if (isTidyDataset) {
                  console.log(`[METADATA REFRESH] Detected tidy dataset '${detectedDataset}' - will become active dataset`);
                }

                console.log(`[METADATA REFRESH] Successfully refreshed metadata for '${detectedDataset}'`);
                console.log(`[METADATA REFRESH] Columns: ${columnMetadata.length}, Categorical: ${columnMetadata.filter(c => c.type === 'categorical').length}, Numeric: ${columnMetadata.filter(c => c.type === 'numeric').length}`);

                // Log numeric columns with their ranges
                const numericWithRanges = columnMetadata.filter(c => c.type === 'numeric' && c.min !== undefined && c.max !== undefined);
                if (numericWithRanges.length > 0) {
                  console.log(`[METADATA REFRESH] Numeric columns with ranges:`);
                  numericWithRanges.forEach(col => {
                    console.log(`  - ${col.name}: ${col.min} to ${col.max}`);
                  });
                }
              }
            } else {
              console.log(`[METADATA REFRESH] Dataset '${detectedDataset}' does not exist in workspace`);
            }
          } catch (metadataError) {
            console.error('[METADATA REFRESH] Failed to refresh metadata:', metadataError);
            // Don't fail the whole request, just skip metadata
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
 * GET /api/list-dataframes
 * List all data.frame and tbl_df objects currently in the R workspace
 */
app.get('/api/list-dataframes', async (req, res) => {
  const tempDir = join(tmpdir(), '3panel-r-execution');
  const workspacePath = join(tempDir, 'workspace.RData');

  try {
    // R code to list all data frames with their dimensions
    const rCode = `
# Load workspace if it exists
if (file.exists("${workspacePath.replace(/\\/g, '\\\\')}")) {
  load("${workspacePath.replace(/\\/g, '\\\\')}")
}

# Get all objects in workspace
objects_list <- ls()

# Extract info about data frames and tibbles
df_info <- lapply(objects_list, function(name) {
  obj <- tryCatch(get(name), error = function(e) NULL)
  if (!is.null(obj) && (is.data.frame(obj) || inherits(obj, "tbl_df"))) {
    dims <- dim(obj)
    list(name = name, rows = dims[1], cols = dims[2])
  }
})

# Remove NULL entries
df_info <- Filter(Negate(is.null), df_info)

# Convert to JSON
cat(jsonlite::toJSON(df_info, auto_unbox = TRUE))
`;

    // Execute R code
    const result = await new Promise((resolve, reject) => {
      const rProcess = spawn('R', ['--vanilla', '--slave'], {
        cwd: tempDir
      });

      let stdout = '';
      let stderr = '';

      rProcess.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      rProcess.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      rProcess.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`R process exited with code ${code}: ${stderr}`));
        } else {
          resolve({ stdout, stderr });
        }
      });

      rProcess.stdin.write(rCode);
      rProcess.stdin.end();
    });

    // Parse the JSON output from R
    let dataframes = [];
    try {
      dataframes = JSON.parse(result.stdout.trim());
    } catch (e) {
      console.error('Error parsing R output:', e);
    }

    res.json({ dataframes });
  } catch (error) {
    console.error('Error listing data frames:', error);
    res.status(500).json({ error: error.message, dataframes: [] });
  }
});

/**
 * POST /api/load-and-report-data
 * Two-phase dataset loading with accurate reporting:
 * Phase 1: Generate and execute R diagnostic code
 * Phase 2: Have Claude analyze actual R output and write accurate report
 *
 * Body:
 * - filename: Name of the file to load
 * - apiKey: Anthropic API key
 * - suggestionsEnabled: Whether suggestions are enabled
 */
app.post('/api/load-and-report-data', async (req, res) => {
  const tempDir = join(tmpdir(), '3panel-r-execution');
  const dataDir = join(process.cwd(), 'data');
  const workspacePath = join(tempDir, 'workspace.RData');

  try {
    const { filename, apiKey, suggestionsEnabled } = req.body;

    if (!filename || !apiKey) {
      return res.status(400).json({ error: 'Filename and API key are required' });
    }

    // Ensure temp directory exists
    await mkdir(tempDir, { recursive: true });

    // Initialize Anthropic client
    const anthropic = new Anthropic({ apiKey });

    // ==== PHASE 1: Use explicit diagnostic R code ====
    // Create a valid R variable name from the filename
    // Remove .csv extension and sanitize for R (replace invalid chars with underscores)
    let baseFilename = filename.replace(/\.csv$/i, ''); // Remove .csv extension
    baseFilename = baseFilename.replace(/[^a-zA-Z0-9_]/g, '_'); // Replace invalid chars
    baseFilename = baseFilename.replace(/^(\d)/, '_$1'); // Ensure it doesn't start with a number

    // Generate explicit diagnostic code instead of asking Claude
    const diagnosticCode = `# Suppress package startup messages
suppressPackageStartupMessages({
  library(dplyr)
  library(tidyr)
})

# Load CSV - try with comment.char="#" which auto-skips comment lines
${baseFilename} <- tryCatch({
  read.csv("${filename}", comment.char="#")
}, error = function(e) {
  # If that fails, try skipping first line
  cat("First attempt failed, trying with skip=1\\n")
  read.csv("${filename}", skip=1, comment.char="")
})

# Dimensions
cat("Dimensions:\\n")
cat(paste("Rows:", nrow(${baseFilename}), "\\n"))
cat(paste("Columns:", ncol(${baseFilename}), "\\n\\n"))

# Column names
cat("Column names:\\n")
print(names(${baseFilename}))
cat("\\n")

# Missing values per column
cat("Missing values per column:\\n")
print(colSums(is.na(${baseFilename})))
cat("\\nTotal missing values:", sum(is.na(${baseFilename})), "out of", nrow(${baseFilename}) * ncol(${baseFilename}), "total cells\\n\\n")

# Structure
cat("Data structure:\\n")
str(${baseFilename})
cat("\\n")

# First few rows
cat("First few rows:\\n")
print(head(${baseFilename}))
cat("\\n")

# Check for tidy format issues
cat("Checking for tidy format issues...\\n")
col_names <- names(${baseFilename})
year_cols <- grep("^X?[0-9]{4}$", col_names, value = TRUE)
month_cols <- grep("^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)", col_names, value = TRUE, ignore.case = TRUE)

if (length(year_cols) > 0) {
  cat("⚠️  Column names that appear to be years:", paste(year_cols, collapse = ", "), "\\n")
  cat("   Suggest using pivot_longer() to reshape these columns into rows\\n")
} else if (length(month_cols) > 0) {
  cat("⚠️  Column names that appear to be months:", paste(month_cols, collapse = ", "), "\\n")
  cat("   Suggest using pivot_longer() to reshape these columns into rows\\n")
} else {
  cat("✓ Column names appear to be proper variable names\\n")
}
cat("\\n")

# Extract unique values for categorical columns (for interactive suggestions)
cat("Categorical column values:\\n")
for (col_name in names(${baseFilename})) {
  col_data <- ${baseFilename}[[col_name]]
  # Check if column is character or factor (categorical)
  if (is.character(col_data) || is.factor(col_data)) {
    unique_vals <- sort(unique(na.omit(col_data)))
    n_unique <- length(unique_vals)
    # Only show if there are 2-250 unique values (truly categorical)
    if (n_unique >= 2 && n_unique <= 250) {
      cat(paste0("$ ", col_name, ": [", paste(unique_vals, collapse = ", "), "]\\n"))
    }
  }
}
cat("\\n")

# Extract min/max for numeric columns (for interactive sliders)
cat("Numeric column ranges:\\n")
for (col_name in names(${baseFilename})) {
  col_data <- ${baseFilename}[[col_name]]
  # Check if column is numeric
  if (is.numeric(col_data)) {
    clean_data <- na.omit(col_data)
    if (length(clean_data) > 0) {
      min_val <- min(clean_data)
      max_val <- max(clean_data)
      cat(paste0("$ ", col_name, ": ", min_val, " to ", max_val, "\\n"))
    }
  }
}
cat("\\n")`;

    // ==== Execute the diagnostic R code ====
    const timestamp = Date.now();
    const scriptPath = join(tempDir, `diagnostic_${timestamp}.R`);

    // Prepare R script with workspace loading and data directory
    const fullScript = `
# Set working directory to data folder
setwd("${dataDir.replace(/\\/g, '/')}")

# Load workspace if it exists
workspace_path <- "${workspacePath.replace(/\\/g, '/')}"
if (file.exists(workspace_path)) {
  load(workspace_path)
}

# Execute diagnostic code
${diagnosticCode}

# Save workspace
save.image(workspace_path)
`;

    await writeFile(scriptPath, fullScript);

    // Execute R script
    const rOutput = await new Promise((resolve, reject) => {
      exec(`Rscript "${scriptPath}"`, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30000
      }, (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(stderr || error.message));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

    // Clean up script file
    await unlink(scriptPath).catch(() => {});

    // Validate that we got output
    if (!rOutput.stdout || rOutput.stdout.trim().length === 0) {
      console.error('R execution produced no output');
      return res.status(500).json({
        error: 'R execution produced no output',
        details: rOutput.stderr || 'Unknown error'
      });
    }

    // ==== Extract column metadata from R output for interactive suggestions ====
    let columnMetadata = [];
    try {
      // Parse column types from str() output
      const structureMatch = rOutput.stdout.match(/Data structure:[\s\S]*?(?=\n\n|$)/);
      if (structureMatch) {
        const structureText = structureMatch[0];
        // Format: $ colname : type value...
        const colMatches = structureText.matchAll(/\$ (\w+)\s*:\s*(\w+)/g);
        for (const match of colMatches) {
          const [, colName, colType] = match;
          // Categorize as numeric or categorical
          const isNumeric = ['num', 'int', 'dbl', 'numeric', 'integer'].includes(colType.toLowerCase());
          columnMetadata.push({
            name: colName,
            type: isNumeric ? 'numeric' : 'categorical',
            values: []  // Will populate from categorical values section
          });
        }
      }

      // Parse categorical column values
      const categoricalMatch = rOutput.stdout.match(/Categorical column values:[\s\S]*?(?=\n\n|$)/);
      if (categoricalMatch) {
        const categoricalText = categoricalMatch[0];
        // Format: $ colname: [value1, value2, value3]
        // Use [\s\S]*? instead of .*? to match across newlines
        const valueMatches = categoricalText.matchAll(/\$ (\w+): \[([\s\S]*?)\]/g);
        for (const match of valueMatches) {
          const [, colName, valuesStr] = match;
          // Find this column in metadata and add values
          const col = columnMetadata.find(c => c.name === colName);
          if (col) {
            // Parse comma-separated values, trim whitespace, remove "..." if present
            col.values = valuesStr.split(',')
              .map(v => v.trim())
              .filter(v => v && v !== '...');
          }
        }
      }

      // Parse numeric column ranges
      const numericMatch = rOutput.stdout.match(/Numeric column ranges:[\s\S]*?(?=\n\n|$)/);
      if (numericMatch) {
        const numericText = numericMatch[0];
        // Format: $ colname: min to max
        const rangeMatches = numericText.matchAll(/\$ (\w+): ([\d.eE+-]+) to ([\d.eE+-]+)/g);
        for (const match of rangeMatches) {
          const [, colName, minStr, maxStr] = match;
          // Find this column in metadata and add min/max
          const col = columnMetadata.find(c => c.name === colName);
          if (col) {
            col.min = parseFloat(minStr);
            col.max = parseFloat(maxStr);
          }
        }
      }
    } catch (e) {
      console.error('Failed to extract column metadata:', e);
    }

    // ==== PHASE 2: Have Claude analyze the actual output and write report ====
    const jsonSchema = suggestionsEnabled ? `{
  "structure": "Text describing exact dimensions and time range if applicable",
  "tidyFormat": "Text describing whether dataset is tidy and what needs to be reshaped",
  "missingData": "Text describing missing data patterns and counts",
  "subject": "Text describing what the dataset is about",
  "insights": "Text describing analysis potential and data completeness",
  "suggestions": [
    {
      "text": "Complete suggestion text",
      "interactive": {
        "value": "Iris-setosa",
        "context": "species",
        "options": ["Iris-setosa", "Iris-versicolor", "Iris-virginica"]
      }
    }
  ]
}

CRITICAL REQUIREMENTS:
1. Each suggestion MUST be an object with "text" field, NOT a plain string!
2. For interactive: provide ONLY the categorical value, context, and options
   - "value": the exact categorical value that appears in your suggestion text (e.g., "Iris-setosa")
   - "context": brief label like "species", "country", "year"
   - "options": array of alternative values from that categorical column
   - DO NOT provide "start" or "end" - the server will calculate positions automatically

Examples:
✓ CORRECT: {"text": "Create a box plot of SEPAL_LENGTH_CM for Iris-setosa", "interactive": {"value": "Iris-setosa", "context": "species", "options": ["Iris-setosa", "Iris-versicolor", "Iris-virginica"]}}
✗ WRONG: Making "species" interactive (that's a column name, not a value!)
✗ WRONG: Making "distributions" interactive (that's not a categorical value!)
}` : `{
  "title": "Concise descriptive title for the dataset (3-9 words)",
  "structure": "Text describing exact dimensions and time range if applicable",
  "tidyFormat": "Text describing whether dataset is tidy and what needs to be reshaped",
  "missingData": "Text describing missing data patterns and counts",
  "subject": "Text describing what the dataset is about",
  "insights": "Text describing analysis potential and data completeness"
}`;

    // Build column list for the prompt
    const numericColumns = columnMetadata.filter(c => c.type === 'numeric').map(c => c.name);
    const categoricalColumnsWithValues = columnMetadata
      .filter(c => c.type === 'categorical' && c.values.length > 0)
      .map(c => `${c.name}: [${c.values.join(', ')}]`);

    const columnInfo = columnMetadata.length > 0
      ? `\n\nDATASET SCHEMA (for interactive suggestions):
Numeric columns: ${numericColumns.join(', ') || 'none'}
Categorical columns with values (format is COLUMN_NAME: [values]):
${categoricalColumnsWithValues.map(c => `  - ${c}`).join('\n') || 'none'}

CRITICAL: Use the EXACT column names shown above. For example, if you see "TARGET: [Iris-setosa, ...]", use TARGET as the column name, NOT "SPECIES" or any other inferred name.`
      : '';

    let reportSystemPrompt = `You are a data analysis assistant. You have just executed R code to load and examine a dataset.

The user loaded a file called "${filename}". The R diagnostic code has been executed and you can see the ACTUAL output below.${columnInfo}

Based on the ACTUAL R output, write a comprehensive report in JSON format with these sections:

${jsonSchema}

For each section:
- Write 3-5 sentences in paragraph format
- Be concise and specific
- Base your report ENTIRELY on the R output shown below

CRITICAL - Title Generation:
- First, write the "subject" section describing what the dataset is about
- Then, create a "title" field with a concise, descriptive title (3-9 words)
- The title should capture the essence of what the subject describes
- The title should be professional and suitable for a data analysis report
- DO NOT include the title in the subject text - it's a separate field
- Example: if subject is "This dataset contains historical life expectancy data...", title could be "Global Life Expectancy Trends"
${suggestionsEnabled ? `
- For suggestions: provide 2-4 specific, actionable prompts for CHART/PLOT analysis only
- ⚠️ CRITICAL: If data is NOT in tidy format, the FIRST suggestion MUST be a specific prompt to convert it to tidy format using pivot_longer(). This will be ENFORCED by server validation - if data is not tidy and first suggestion is not about conversion, ALL suggestions will be removed.
- Each suggestion MUST be fully executable with specific column names
- For plot suggestions, you MAY mark UP TO TWO elements as interactive (one categorical value + one numeric range):

  OPTION 1 - CATEGORICAL VALUE:
  * Include a specific categorical value in your suggestion (e.g., "for Iris-setosa" or "in Canada")
  * ONLY make actual categorical VALUES interactive (like "Iris-setosa"), NEVER column names
  * Provide interactive object with three fields:
    - "value": the exact categorical value text (e.g., "Iris-setosa")
    - "context": brief label (e.g., "species", "country")
    - "options": array of alternative values from the schema above

  CATEGORICAL EXAMPLE:
  {
    "text": "Create a box plot of SEPAL_LENGTH_CM for Iris-setosa",
    "interactive": {
      "value": "Iris-setosa",
      "context": "species",
      "options": ["Iris-setosa", "Iris-versicolor", "Iris-virginica"]
    }
  }

  OPTION 2 - NUMERIC RANGE:
  * Include a numeric range in your suggestion (e.g., "from 1990 to 2020" or "between 25 and 65")
  * ⚠️ CRITICAL: You MUST explicitly specify which COLUMN the range refers to
  * Provide interactive object with these fields:
    - "type": "numeric-range"
    - "column": the EXACT column name from the schema (e.g., "year", "age", "temperature")
    - "minValue": the minimum value in your suggestion (e.g., 1990)
    - "maxValue": the maximum value in your suggestion (e.g., 2020)

  NUMERIC RANGE EXAMPLE:
  {
    "text": "Create a line plot showing life expectancy trends from 1990 to 2020",
    "interactive": {
      "type": "numeric-range",
      "column": "year",
      "minValue": 1990,
      "maxValue": 2020
    }
  }

  WRONG EXAMPLES:
  ✗ "value": "species" - this is a column name, not a categorical value!
  ✗ "type": "numeric-range" without "column" - you MUST specify the column!
  ✗ "column": "life expectancy" when schema shows "life_expectancy" - use EXACT name!

- Most suggestions (2-3 out of 4) should NOT have interactive elements` : ''}

SPECIAL FORMATTING for "structure" section:
- After your paragraph describing the structure, add TWO newlines, then add a line that starts with "Columns:" followed by a newline
- On the next line, show a horizontal list of the first 10 column names, each followed by a comma, then TWO non-breaking spaces (Unicode \u00A0\u00A0)
- If there are more than 10 columns, the last item in the list should be a count like "10 more cols" instead of the 10th column name
- Example with 8 columns: "The dataset has 100 rows and 8 columns.\\n\\nColumns:\\nCountry,\u00A0\u00A0Region,\u00A0\u00A0Year,\u00A0\u00A0Population,\u00A0\u00A0GDP,\u00A0\u00A0Unemployment,\u00A0\u00A0Inflation,\u00A0\u00A0Exports,"
- Example with 15 columns: "The dataset has 200 rows and 15 columns.\\n\\nColumns:\\nCountry,\u00A0\u00A0Region,\u00A0\u00A0Year,\u00A0\u00A0Population,\u00A0\u00A0GDP,\u00A0\u00A0Unemployment,\u00A0\u00A0Inflation,\u00A0\u00A0Exports,\u00A0\u00A0Imports,\u00A0\u00A05 more cols"

CRITICAL REQUIREMENTS:
- Return ONLY the raw JSON object - no markdown code blocks, no \`\`\`json\`\`\`, no extra text
- All newlines in strings must be escaped as \\n
- All string values must use proper JSON escaping
- Suggestions array contains objects (with text and optional interactive), not plain strings`;

    const reportPrompt = `Here is the R output from loading and examining the dataset:

\`\`\`
${rOutput.stdout}
\`\`\`

${rOutput.stderr ? `\nWarnings/Messages:\n${rOutput.stderr}\n` : ''}

Write your comprehensive report in JSON format based on this actual output.`;

    const phase2Response = await anthropic.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 2048,
      system: reportSystemPrompt,
      messages: [{ role: 'user', content: reportPrompt }]
    });

    const reportText = phase2Response.content[0].text;

    // Parse JSON report
    let reportSections = {};
    let suggestions = [];

    try {
      let jsonText = reportText;

      // Try to extract JSON from markdown code block - find the content between ``` markers
      if (reportText.includes('```')) {
        const startMarker = reportText.indexOf('{');
        const endMarker = reportText.lastIndexOf('}');
        if (startMarker !== -1 && endMarker !== -1 && endMarker > startMarker) {
          jsonText = reportText.substring(startMarker, endMarker + 1);
          console.log('Extracted JSON from code block using brace positions');
        }
      } else {
        // No code block, try to find JSON object boundaries
        const startMarker = reportText.indexOf('{');
        const endMarker = reportText.lastIndexOf('}');
        if (startMarker !== -1 && endMarker !== -1 && endMarker > startMarker) {
          jsonText = reportText.substring(startMarker, endMarker + 1);
          console.log('Found JSON object using brace positions');
        } else {
          console.log('No JSON pattern found, using entire response');
        }
      }

      console.log('Attempting to parse JSON:', jsonText.substring(0, 200) + '...');
      const reportData = JSON.parse(jsonText);

      reportSections = {
        title: reportData.title || '',
        structure: reportData.structure || '',
        tidyFormat: reportData.tidyFormat || '',
        missingData: reportData.missingData || '',
        subject: reportData.subject || '',
        insights: reportData.insights || ''
      };
      suggestions = reportData.suggestions || [];

      console.log('[CSV] Report sections parsed, title:', reportSections.title);

      // Validate and auto-calculate positions for interactive suggestions
      if (suggestions && suggestions.length > 0) {
        // Get all categorical values from metadata for validation
        const allCategoricalValues = [];
        for (const col of columnMetadata) {
          if (col.type === 'categorical' && col.values && col.values.length > 0) {
            allCategoricalValues.push(...col.values);
          }
        }

        // Get all valid column names for validation
        const allColumnNames = columnMetadata.map(c => c.name);
        console.log('[CSV] Valid column names:', allColumnNames);
        console.log('[CSV] All categorical values for validation:', allCategoricalValues);

        for (let i = 0; i < suggestions.length; i++) {
          const sug = suggestions[i];

          // Check if this is a tidy conversion suggestion
          const sugTextLower = sug.text.toLowerCase();
          const isTidyConversion = sugTextLower.includes('tidy') ||
                                  sugTextLower.includes('pivot') ||
                                  sugTextLower.includes('reshape');

          // Skip column validation for tidy conversion suggestions
          // (they often reference column ranges like X1800:X2100 that may not exactly match)
          if (!isTidyConversion) {
            // Validate column names in suggestion text
            // Look for uppercase words or words with underscores that might be column names
            const potentialColumnNames = sug.text.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || [];
            const invalidColumnNames = potentialColumnNames.filter(name =>
              !allColumnNames.includes(name) &&
              !allCategoricalValues.includes(name) // Not a categorical value either
            );

            if (invalidColumnNames.length > 0) {
              console.log(`⚠️  [CSV] Suggestion ${i} contains HALLUCINATED column names: ${invalidColumnNames.join(', ')}`);
              console.log(`   Valid columns are: ${allColumnNames.join(', ')}`);
              console.log(`   Suggestion text: "${sug.text}"`);
              console.log(`   ❌ REMOVING suggestion due to hallucinated column names`);
              // Mark for removal
              suggestions[i] = null;
              continue;
            }
          } else {
            console.log(`[CSV] Suggestion ${i} is about tidy conversion - skipping column name validation`);
          }

          if (sug.interactive) {
            const { value } = sug.interactive;

            console.log(`[CSV] Suggestion ${i}: Checking interactive value "${value}"`);
            console.log(`  - Is "${value}" a categorical value?`, allCategoricalValues.includes(value));

            // Check if value is valid
            if (!allCategoricalValues.includes(value)) {
              console.log(`  ✗ INVALID - not a categorical value, removing`);
              delete sug.interactive;
              continue;
            }

            // Find the value in the suggestion text
            const valueIndex = sug.text.indexOf(value);
            if (valueIndex === -1) {
              console.log(`  ✗ INVALID - value "${value}" not found in text, removing`);
              delete sug.interactive;
              continue;
            }

            // Find which column this value belongs to and use its full sorted values
            const sourceColumn = columnMetadata.find(col =>
              col.type === 'categorical' && col.values && col.values.includes(value)
            );

            if (sourceColumn) {
              // Replace options with full sorted list from column metadata
              sug.interactive.options = [...sourceColumn.values].sort();
              console.log(`  - Replaced options with ${sug.interactive.options.length} sorted values from column ${sourceColumn.name}`);
            }

            // Calculate positions and add them
            sug.interactive.start = valueIndex;
            sug.interactive.end = valueIndex + value.length;

            console.log(`  ✓ Valid - added positions ${sug.interactive.start}-${sug.interactive.end}`);
          }
        }

        // Filter out null suggestions (those with invalid column names)
        suggestions = suggestions.filter(s => s !== null);
        console.log(`[CSV] After validation: ${suggestions.length} suggestions remain`);

        // CRITICAL: If data is not tidy, ensure first suggestion is about converting to tidy format
        console.log('=== TIDY FORMAT VALIDATION (CSV) ===');
        console.log('Suggestions count:', suggestions.length);
        console.log('Has tidyFormat section:', !!reportSections.tidyFormat);

        if (suggestions.length > 0 && reportSections.tidyFormat) {
          const tidyText = reportSections.tidyFormat.toLowerCase();
          console.log('TidyFormat text:', reportSections.tidyFormat);

          // Check if data IS already tidy (positive indicators)
          const isTidy = tidyText.includes('already in tidy') ||
                        tidyText.includes('is in tidy') ||
                        tidyText.includes('is tidy') ||
                        tidyText.includes('no reshaping') ||
                        tidyText.includes('no pivot') ||
                        tidyText.includes('not required') && tidyText.includes('pivot');

          // Check if data is NOT tidy (negative indicators)
          const isNotTidy = !isTidy && (
                           tidyText.includes('not tidy') ||
                           tidyText.includes('not in tidy format') ||
                           tidyText.includes('needs to be reshaped') ||
                           tidyText.includes('should be reshaped') ||
                           tidyText.includes('requires reshaping') ||
                           tidyText.includes('should use pivot') ||
                           tidyText.includes('needs pivot'));

          console.log('isNotTidy:', isNotTidy);

          if (isNotTidy) {
            // Check if first suggestion is about tidy conversion
            const firstSug = suggestions[0].text.toLowerCase();
            console.log('First suggestion text:', suggestions[0].text);

            const isTidyConversion = firstSug.includes('tidy') ||
                                    firstSug.includes('pivot') ||
                                    firstSug.includes('reshape');

            console.log('isTidyConversion:', isTidyConversion);

            if (!isTidyConversion) {
              console.log('⚠️  [CSV] Data is not tidy but first suggestion is not about conversion');
              console.log('   Removing non-tidy-conversion suggestions as data must be tidied first');
              // Remove all suggestions since they won't work without tidy data
              suggestions = [];
            } else {
              console.log('✓ [CSV] Data is not tidy and first suggestion correctly addresses tidy conversion');
            }
          } else {
            console.log('✓ [CSV] Data appears to be in tidy format');
          }
        }
        console.log('=== END TIDY FORMAT VALIDATION (CSV) ===');
      }

      console.log('Successfully parsed report sections');
    } catch (e) {
      console.error('Failed to parse report JSON:', e);
      console.error('Raw response text:', reportText);
      // Fallback to original text format
      reportSections = { structure: reportText };
    }

    // Filter out inconsequential warnings from stderr
    let filteredError = null;
    if (rOutput.stderr) {
      const lines = rOutput.stderr.split('\n');
      const filtered = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nextLine = i < lines.length - 1 ? lines[i + 1] : '';

        // Skip "Warning message:" if next line is about package version
        if (line.trim() === 'Warning message:' && nextLine.includes('was built under R version')) {
          i++; // Skip the next line too
          continue;
        }

        // Skip lines about package version mismatches
        if (line.includes('was built under R version')) {
          continue;
        }

        // Keep non-empty lines
        if (line.trim().length > 0) {
          filtered.push(line);
        }
      }

      filteredError = filtered.length > 0 ? filtered.join('\n') : null;
    }

    // Extract title from reportSections and send separately
    const reportTitle = reportSections.title || `Dataset: ${filename}`;
    // Remove title from reportSections so it doesn't appear in the UI tabs
    delete reportSections.title;

    // Return complete response
    res.json({
      success: true,
      reportSections: reportSections,
      reportTitle: reportTitle,
      code: diagnosticCode,
      output: rOutput.stdout,
      error: filteredError,
      suggestions: suggestions,
      filename: filename,
      variableName: baseFilename,  // Add the sanitized R variable name
      columnMetadata: columnMetadata  // Include schema for future chat requests
    });

  } catch (error) {
    console.error('Error in load-and-report-data:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      error: error.message || 'Failed to load and report on data',
      details: error.stack
    });
  }
});

/**
 * POST /api/load-and-report-snowflake
 * Load and analyze a Snowflake table/view with comprehensive reporting
 * Similar to load-and-report-data but for Snowflake sources
 *
 * Request body:
 * - database: Snowflake database name
 * - schema: Snowflake schema name
 * - tableName: Snowflake table/view name
 * - varName: R variable name to use
 * - apiKey: Anthropic API key
 * - suggestionsEnabled: Whether suggestions are enabled
 */
app.post('/api/load-and-report-snowflake', async (req, res) => {
  const tempDir = join(tmpdir(), '3panel-r-execution');
  const workspacePath = join(tempDir, 'workspace.RData');

  try {
    const { database, schema, tableName, varName, apiKey, suggestionsEnabled } = req.body;

    if (!database || !schema || !tableName || !varName || !apiKey) {
      return res.status(400).json({ error: 'Database, schema, table name, variable name, and API key are required' });
    }

    // Ensure temp directory exists
    await mkdir(tempDir, { recursive: true });

    // Initialize Anthropic client
    const anthropic = new Anthropic({ apiKey });

    // ==== PHASE 1: Generate explicit diagnostic R code ====
    const diagnosticCode = `# Suppress package startup messages
suppressPackageStartupMessages({
  library(dplyr)
  library(tidyr)
})

# Load table from Snowflake
${varName} <- sf_query("SELECT * FROM ${database}.${schema}.${tableName} LIMIT 1000")

# Dimensions
cat("Dimensions:\\n")
cat(paste("Rows:", nrow(${varName}), "\\n"))
cat(paste("Columns:", ncol(${varName}), "\\n\\n"))

# Column names
cat("Column names:\\n")
print(names(${varName}))
cat("\\n")

# Missing values per column
cat("Missing values per column:\\n")
print(colSums(is.na(${varName})))
cat("\\nTotal missing values:", sum(is.na(${varName})), "out of", nrow(${varName}) * ncol(${varName}), "total cells\\n\\n")

# Structure
cat("Data structure:\\n")
str(${varName})
cat("\\n")

# First few rows
cat("First few rows:\\n")
print(head(${varName}))
cat("\\n")

# Check for tidy format issues
cat("Checking for tidy format issues...\\n")
col_names <- names(${varName})
year_cols <- grep("^X?[0-9]{4}$", col_names, value = TRUE)
month_cols <- grep("^(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)", col_names, value = TRUE, ignore.case = TRUE)

if (length(year_cols) > 0) {
  cat("⚠️  Column names that appear to be years:", paste(year_cols, collapse = ", "), "\\n")
  cat("   Suggest using pivot_longer() to reshape these columns into rows\\n")
} else if (length(month_cols) > 0) {
  cat("⚠️  Column names that appear to be months:", paste(month_cols, collapse = ", "), "\\n")
  cat("   Suggest using pivot_longer() to reshape these columns into rows\\n")
} else {
  cat("✓ Column names appear to be proper variable names\\n")
}
cat("\\n")

# Extract unique values for categorical columns (for interactive suggestions)
cat("Categorical column values:\\n")
for (col_name in names(${varName})) {
  col_data <- ${varName}[[col_name]]
  # Check if column is character or factor (categorical)
  if (is.character(col_data) || is.factor(col_data)) {
    unique_vals <- sort(unique(na.omit(col_data)))
    n_unique <- length(unique_vals)
    # Only show if there are 2-250 unique values (truly categorical)
    if (n_unique >= 2 && n_unique <= 250) {
      cat(paste0("$ ", col_name, ": [", paste(unique_vals, collapse = ", "), "]\\n"))
    }
  }
}
cat("\\n")

# Extract min/max for numeric columns (for interactive sliders)
cat("Numeric column ranges:\\n")
for (col_name in names(${varName})) {
  col_data <- ${varName}[[col_name]]
  # Check if column is numeric
  if (is.numeric(col_data)) {
    clean_data <- na.omit(col_data)
    if (length(clean_data) > 0) {
      min_val <- min(clean_data)
      max_val <- max(clean_data)
      cat(paste0("$ ", col_name, ": ", min_val, " to ", max_val, "\\n"))
    }
  }
}
cat("\\n")`;

    // ==== Execute the diagnostic R code ====
    const timestamp = Date.now();
    const scriptPath = join(tempDir, `diagnostic_snowflake_${timestamp}.R`);

    // Prepare R script with workspace loading
    const fullScript = `
# Load workspace if it exists
workspace_path <- "${workspacePath.replace(/\\/g, '/')}"
if (file.exists(workspace_path)) {
  load(workspace_path)
}

# Execute diagnostic code
${diagnosticCode}

# Save workspace
save.image(workspace_path)
`;

    await writeFile(scriptPath, fullScript);

    // Execute R script
    const rOutput = await new Promise((resolve, reject) => {
      exec(`Rscript "${scriptPath}"`, {
        maxBuffer: 10 * 1024 * 1024,
        timeout: 60000
      }, (error, stdout, stderr) => {
        if (error && !stdout) {
          reject(new Error(stderr || error.message));
        } else {
          resolve({ stdout, stderr });
        }
      });
    });

    // Clean up script file
    await unlink(scriptPath).catch(() => {});

    // Validate that we got output
    if (!rOutput.stdout || rOutput.stdout.trim().length === 0) {
      console.error('R execution produced no output');
      return res.status(500).json({
        error: 'R execution produced no output',
        details: rOutput.stderr || 'Unknown error'
      });
    }

    // ==== Extract column metadata from R output for interactive suggestions ====
    let columnMetadata = [];
    try {
      // Parse column types from str() output
      const structureMatch = rOutput.stdout.match(/Data structure:[\s\S]*?(?=\n\n|$)/);
      if (structureMatch) {
        const structureText = structureMatch[0];
        // Format: $ colname : type value...
        const colMatches = structureText.matchAll(/\$ (\w+)\s*:\s*(\w+)/g);
        for (const match of colMatches) {
          const [, colName, colType] = match;
          // Categorize as numeric or categorical
          const isNumeric = ['num', 'int', 'dbl', 'numeric', 'integer'].includes(colType.toLowerCase());
          columnMetadata.push({
            name: colName,
            type: isNumeric ? 'numeric' : 'categorical',
            values: []  // Will populate from categorical values section
          });
        }
      }

      // Parse categorical column values
      const categoricalMatch = rOutput.stdout.match(/Categorical column values:[\s\S]*?(?=\n\n|$)/);
      if (categoricalMatch) {
        const categoricalText = categoricalMatch[0];
        // Format: $ colname: [value1, value2, value3]
        // Use [\s\S]*? instead of .*? to match across newlines
        const valueMatches = categoricalText.matchAll(/\$ (\w+): \[([\s\S]*?)\]/g);
        for (const match of valueMatches) {
          const [, colName, valuesStr] = match;
          // Find this column in metadata and add values
          const col = columnMetadata.find(c => c.name === colName);
          if (col) {
            // Parse comma-separated values, trim whitespace, remove "..." if present
            col.values = valuesStr.split(',')
              .map(v => v.trim())
              .filter(v => v && v !== '...');
          }
        }
      }

      // Parse numeric column ranges
      const numericMatch = rOutput.stdout.match(/Numeric column ranges:[\s\S]*?(?=\n\n|$)/);
      if (numericMatch) {
        const numericText = numericMatch[0];
        // Format: $ colname: min to max
        const rangeMatches = numericText.matchAll(/\$ (\w+): ([\d.eE+-]+) to ([\d.eE+-]+)/g);
        for (const match of rangeMatches) {
          const [, colName, minStr, maxStr] = match;
          // Find this column in metadata and add min/max
          const col = columnMetadata.find(c => c.name === colName);
          if (col) {
            col.min = parseFloat(minStr);
            col.max = parseFloat(maxStr);
          }
        }
      }
    } catch (e) {
      console.error('Failed to extract column metadata:', e);
    }

    // ==== PHASE 2: Have Claude analyze the actual output and write report ====
    const jsonSchema = suggestionsEnabled ? `{
  "structure": "Text describing exact dimensions and time range if applicable",
  "tidyFormat": "Text describing whether dataset is tidy and what needs to be reshaped",
  "missingData": "Text describing missing data patterns and counts",
  "subject": "Text describing what the dataset is about",
  "insights": "Text describing analysis potential and data completeness",
  "suggestions": [
    {
      "text": "Complete suggestion text",
      "interactive": {
        "value": "Iris-setosa",
        "context": "species",
        "options": ["Iris-setosa", "Iris-versicolor", "Iris-virginica"]
      }
    }
  ]
}

CRITICAL REQUIREMENTS:
1. Each suggestion MUST be an object with "text" field, NOT a plain string!
2. For interactive: provide ONLY the categorical value, context, and options
   - "value": the exact categorical value that appears in your suggestion text (e.g., "Iris-setosa")
   - "context": brief label like "species", "country", "year"
   - "options": array of alternative values from that categorical column
   - DO NOT provide "start" or "end" - the server will calculate positions automatically

Examples:
✓ CORRECT: {"text": "Create a box plot of SEPAL_LENGTH_CM for Iris-setosa", "interactive": {"value": "Iris-setosa", "context": "species", "options": ["Iris-setosa", "Iris-versicolor", "Iris-virginica"]}}
✗ WRONG: Making "species" interactive (that's a column name, not a value!)
✗ WRONG: Making "distributions" interactive (that's not a categorical value!)
}` : `{
  "title": "Concise descriptive title for the dataset (3-9 words)",
  "structure": "Text describing exact dimensions and time range if applicable",
  "tidyFormat": "Text describing whether dataset is tidy and what needs to be reshaped",
  "missingData": "Text describing missing data patterns and counts",
  "subject": "Text describing what the dataset is about",
  "insights": "Text describing analysis potential and data completeness"
}`;

    // Build column list for the prompt
    const numericColumns = columnMetadata.filter(c => c.type === 'numeric').map(c => c.name);
    const categoricalColumnsWithValues = columnMetadata
      .filter(c => c.type === 'categorical' && c.values.length > 0)
      .map(c => `${c.name}: [${c.values.join(', ')}]`);

    const columnInfo = columnMetadata.length > 0
      ? `\n\nDATASET SCHEMA (for interactive suggestions):
Numeric columns: ${numericColumns.join(', ') || 'none'}
Categorical columns with values (format is COLUMN_NAME: [values]):
${categoricalColumnsWithValues.map(c => `  - ${c}`).join('\n') || 'none'}

CRITICAL: Use the EXACT column names shown above. For example, if you see "TARGET: [Iris-setosa, ...]", use TARGET as the column name, NOT "SPECIES" or any other inferred name.`
      : '';

    let reportSystemPrompt = `You are a data analysis assistant. You have just executed R code to load and examine a Snowflake table.

The user loaded a Snowflake table "${database}.${schema}.${tableName}". The R diagnostic code has been executed and you can see the ACTUAL output below.${columnInfo}

Based on the ACTUAL R output, write a comprehensive report in JSON format with these sections:

${jsonSchema}

For each section:
- Write 3-5 sentences in paragraph format
- Be concise and specific
- Base your report ENTIRELY on the R output shown below

CRITICAL - Title Generation:
- First, write the "subject" section describing what the dataset is about
- Then, create a "title" field with a concise, descriptive title (3-9 words)
- The title should capture the essence of what the subject describes
- The title should be professional and suitable for a data analysis report
- DO NOT include the title in the subject text - it's a separate field
- Example: if subject is "This dataset contains historical life expectancy data...", title could be "Global Life Expectancy Trends"
${suggestionsEnabled ? `
- For suggestions: provide 2-4 specific, actionable prompts for CHART/PLOT analysis only
- ⚠️ CRITICAL: If data is NOT in tidy format, the FIRST suggestion MUST be a specific prompt to convert it to tidy format using pivot_longer(). This will be ENFORCED by server validation - if data is not tidy and first suggestion is not about conversion, ALL suggestions will be removed.
- Each suggestion MUST be fully executable with specific column names
- For plot suggestions, you MAY mark UP TO TWO elements as interactive (one categorical value + one numeric range):

  OPTION 1 - CATEGORICAL VALUE:
  * Include a specific categorical value in your suggestion (e.g., "for Iris-setosa" or "in Canada")
  * ONLY make actual categorical VALUES interactive (like "Iris-setosa"), NEVER column names
  * Provide interactive object with three fields:
    - "value": the exact categorical value text (e.g., "Iris-setosa")
    - "context": brief label (e.g., "species", "country")
    - "options": array of alternative values from the schema above

  CATEGORICAL EXAMPLE:
  {
    "text": "Create a box plot of SEPAL_LENGTH_CM for Iris-setosa",
    "interactive": {
      "value": "Iris-setosa",
      "context": "species",
      "options": ["Iris-setosa", "Iris-versicolor", "Iris-virginica"]
    }
  }

  OPTION 2 - NUMERIC RANGE:
  * Include a numeric range in your suggestion (e.g., "from 1990 to 2020" or "between 25 and 65")
  * ⚠️ CRITICAL: You MUST explicitly specify which COLUMN the range refers to
  * Provide interactive object with these fields:
    - "type": "numeric-range"
    - "column": the EXACT column name from the schema (e.g., "year", "age", "temperature")
    - "minValue": the minimum value in your suggestion (e.g., 1990)
    - "maxValue": the maximum value in your suggestion (e.g., 2020)

  NUMERIC RANGE EXAMPLE:
  {
    "text": "Create a line plot showing life expectancy trends from 1990 to 2020",
    "interactive": {
      "type": "numeric-range",
      "column": "year",
      "minValue": 1990,
      "maxValue": 2020
    }
  }

  WRONG EXAMPLES:
  ✗ "value": "species" - this is a column name, not a categorical value!
  ✗ "type": "numeric-range" without "column" - you MUST specify the column!
  ✗ "column": "life expectancy" when schema shows "life_expectancy" - use EXACT name!

- Most suggestions (2-3 out of 4) should NOT have interactive elements` : ''}

SPECIAL FORMATTING for "structure" section:
- After your paragraph describing the structure, add TWO newlines, then add a line that starts with "Columns:" followed by a newline
- On the next line, show a horizontal list of the first 10 column names, each followed by a comma, then TWO non-breaking spaces (Unicode \u00A0\u00A0)
- If there are more than 10 columns, the last item in the list should be a count like "10 more cols" instead of the 10th column name
- Example with 8 columns: "The dataset has 100 rows and 8 columns.\\n\\nColumns:\\nCountry,\u00A0\u00A0Region,\u00A0\u00A0Year,\u00A0\u00A0Population,\u00A0\u00A0GDP,\u00A0\u00A0Unemployment,\u00A0\u00A0Inflation,\u00A0\u00A0Exports,"
- Example with 15 columns: "The dataset has 200 rows and 15 columns.\\n\\nColumns:\\nCountry,\u00A0\u00A0Region,\u00A0\u00A0Year,\u00A0\u00A0Population,\u00A0\u00A0GDP,\u00A0\u00A0Unemployment,\u00A0\u00A0Inflation,\u00A0\u00A0Exports,\u00A0\u00A0Imports,\u00A0\u00A05 more cols"

CRITICAL REQUIREMENTS:
- Return ONLY the raw JSON object - no markdown code blocks, no \`\`\`json\`\`\`, no extra text
- All newlines in strings must be escaped as \\n
- All string values must use proper JSON escaping
- Suggestions array contains objects (with text and optional interactive), not plain strings`;

    const reportPrompt = `Here is the R output from loading and examining the Snowflake table:

\`\`\`
${rOutput.stdout}
\`\`\`

${rOutput.stderr ? `\nWarnings/Messages:\n${rOutput.stderr}\n` : ''}

Write your comprehensive report in JSON format based on this actual output.`;

    const phase2Response = await anthropic.messages.create({
      model: 'claude-opus-4-5-20251101',
      max_tokens: 2048,
      system: reportSystemPrompt,
      messages: [{ role: 'user', content: reportPrompt }]
    });

    const reportText = phase2Response.content[0].text;
    console.log('=== SNOWFLAKE REPORT GENERATION ===');
    console.log('Raw Claude response length:', reportText.length);
    console.log('First 500 chars:', reportText.substring(0, 500));

    // Parse JSON report
    let reportSections = {};
    let suggestions = [];

    try {
      let jsonText = reportText;

      // Try to extract JSON from markdown code block - find the content between ``` markers
      if (reportText.includes('```')) {
        const startMarker = reportText.indexOf('{');
        const endMarker = reportText.lastIndexOf('}');
        if (startMarker !== -1 && endMarker !== -1 && endMarker > startMarker) {
          jsonText = reportText.substring(startMarker, endMarker + 1);
          console.log('Extracted JSON from code block using brace positions');
        }
      } else {
        // No code block, try to find JSON object boundaries
        const startMarker = reportText.indexOf('{');
        const endMarker = reportText.lastIndexOf('}');
        if (startMarker !== -1 && endMarker !== -1 && endMarker > startMarker) {
          jsonText = reportText.substring(startMarker, endMarker + 1);
          console.log('Found JSON object using brace positions');
        } else {
          console.log('No JSON pattern found, using entire response');
        }
      }

      console.log('JSON to parse (first 300 chars):', jsonText.substring(0, 300));
      const reportData = JSON.parse(jsonText);
      console.log('Successfully parsed JSON, keys:', Object.keys(reportData));

      reportSections = {
        title: reportData.title || '',
        structure: reportData.structure || '',
        tidyFormat: reportData.tidyFormat || '',
        missingData: reportData.missingData || '',
        subject: reportData.subject || '',
        insights: reportData.insights || ''
      };
      suggestions = reportData.suggestions || [];

      console.log('[SNOWFLAKE] Report sections parsed, title:', reportSections.title);

      // Validate and auto-calculate positions for interactive suggestions
      if (suggestions && suggestions.length > 0) {
        // Get all categorical values from metadata for validation
        const allCategoricalValues = [];
        for (const col of columnMetadata) {
          if (col.type === 'categorical' && col.values && col.values.length > 0) {
            allCategoricalValues.push(...col.values);
          }
        }

        // Get all valid column names for validation
        const allColumnNames = columnMetadata.map(c => c.name);
        console.log('[SNOWFLAKE] Valid column names:', allColumnNames);
        console.log('[SNOWFLAKE] All categorical values for validation:', allCategoricalValues);

        for (let i = 0; i < suggestions.length; i++) {
          const sug = suggestions[i];

          // Check if this is a tidy conversion suggestion
          const sugTextLower = sug.text.toLowerCase();
          const isTidyConversion = sugTextLower.includes('tidy') ||
                                  sugTextLower.includes('pivot') ||
                                  sugTextLower.includes('reshape');

          // Skip column validation for tidy conversion suggestions
          // (they often reference column ranges like X1800:X2100 that may not exactly match)
          if (!isTidyConversion) {
            // Validate column names in suggestion text
            // Look for uppercase words or words with underscores that might be column names
            const potentialColumnNames = sug.text.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || [];
            const invalidColumnNames = potentialColumnNames.filter(name =>
              !allColumnNames.includes(name) &&
              !allCategoricalValues.includes(name) // Not a categorical value either
            );

            if (invalidColumnNames.length > 0) {
              console.log(`⚠️  [SNOWFLAKE] Suggestion ${i} contains HALLUCINATED column names: ${invalidColumnNames.join(', ')}`);
              console.log(`   Valid columns are: ${allColumnNames.join(', ')}`);
              console.log(`   Suggestion text: "${sug.text}"`);
              console.log(`   ❌ REMOVING suggestion due to hallucinated column names`);
              // Mark for removal
              suggestions[i] = null;
              continue;
            }
          } else {
            console.log(`[SNOWFLAKE] Suggestion ${i} is about tidy conversion - skipping column name validation`);
          }

          if (sug.interactive) {
            const { value } = sug.interactive;

            console.log(`[SNOWFLAKE] Suggestion ${i}: Checking interactive value "${value}"`);
            console.log(`  - Is "${value}" a categorical value?`, allCategoricalValues.includes(value));

            // Check if value is valid
            if (!allCategoricalValues.includes(value)) {
              console.log(`  ✗ INVALID - not a categorical value, removing`);
              delete sug.interactive;
              continue;
            }

            // Find the value in the suggestion text
            const valueIndex = sug.text.indexOf(value);
            if (valueIndex === -1) {
              console.log(`  ✗ INVALID - value "${value}" not found in text, removing`);
              delete sug.interactive;
              continue;
            }

            // Find which column this value belongs to and use its full sorted values
            const sourceColumn = columnMetadata.find(col =>
              col.type === 'categorical' && col.values && col.values.includes(value)
            );

            if (sourceColumn) {
              // Replace options with full sorted list from column metadata
              sug.interactive.options = [...sourceColumn.values].sort();
              console.log(`  - Replaced options with ${sug.interactive.options.length} sorted values from column ${sourceColumn.name}`);
            }

            // Calculate positions and add them
            sug.interactive.start = valueIndex;
            sug.interactive.end = valueIndex + value.length;

            console.log(`  ✓ Valid - added positions ${sug.interactive.start}-${sug.interactive.end}`);
          }
        }

        // Filter out null suggestions (those with invalid column names)
        suggestions = suggestions.filter(s => s !== null);
        console.log(`[SNOWFLAKE] After validation: ${suggestions.length} suggestions remain`);

        // CRITICAL: If data is not tidy, ensure first suggestion is about converting to tidy format
        console.log('=== TIDY FORMAT VALIDATION (SNOWFLAKE) ===');
        console.log('Suggestions count:', suggestions.length);
        console.log('Has tidyFormat section:', !!reportSections.tidyFormat);

        if (suggestions.length > 0 && reportSections.tidyFormat) {
          const tidyText = reportSections.tidyFormat.toLowerCase();
          console.log('TidyFormat text:', reportSections.tidyFormat);

          // Check if data IS already tidy (positive indicators)
          const isTidy = tidyText.includes('already in tidy') ||
                        tidyText.includes('is in tidy') ||
                        tidyText.includes('is tidy') ||
                        tidyText.includes('no reshaping') ||
                        tidyText.includes('no pivot') ||
                        tidyText.includes('not required') && tidyText.includes('pivot');

          // Check if data is NOT tidy (negative indicators)
          const isNotTidy = !isTidy && (
                           tidyText.includes('not tidy') ||
                           tidyText.includes('not in tidy format') ||
                           tidyText.includes('needs to be reshaped') ||
                           tidyText.includes('should be reshaped') ||
                           tidyText.includes('requires reshaping') ||
                           tidyText.includes('should use pivot') ||
                           tidyText.includes('needs pivot'));

          console.log('isNotTidy:', isNotTidy);

          if (isNotTidy) {
            // Check if first suggestion is about tidy conversion
            const firstSug = suggestions[0].text.toLowerCase();
            console.log('First suggestion text:', suggestions[0].text);

            const isTidyConversion = firstSug.includes('tidy') ||
                                    firstSug.includes('pivot') ||
                                    firstSug.includes('reshape');

            console.log('isTidyConversion:', isTidyConversion);

            if (!isTidyConversion) {
              console.log('⚠️  [SNOWFLAKE] Data is not tidy but first suggestion is not about conversion');
              console.log('   Removing non-tidy-conversion suggestions as data must be tidied first');
              // Remove all suggestions since they won't work without tidy data
              suggestions = [];
            } else {
              console.log('✓ [SNOWFLAKE] Data is not tidy and first suggestion correctly addresses tidy conversion');
            }
          } else {
            console.log('✓ [SNOWFLAKE] Data appears to be in tidy format');
          }
        }
        console.log('=== END TIDY FORMAT VALIDATION (SNOWFLAKE) ===');
      }

      console.log('Report sections created:', Object.keys(reportSections));
      console.log('Structure length:', reportSections.structure?.length || 0);
      console.log('Suggestions count:', suggestions.length);
    } catch (e) {
      console.error('SNOWFLAKE: Failed to parse report JSON:', e.message);
      console.error('Full error:', e);
      console.error('Raw response text (first 1000 chars):', reportText.substring(0, 1000));
      // Fallback to original text format
      reportSections = { structure: reportText };
      console.log('Using fallback reportSections');
    }

    console.log('Final reportSections keys before sending:', Object.keys(reportSections));

    // Filter out inconsequential warnings from stderr
    let filteredError = null;
    if (rOutput.stderr) {
      const lines = rOutput.stderr.split('\n');
      const filtered = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const nextLine = i < lines.length - 1 ? lines[i + 1] : '';

        // Skip "Warning message:" if next line is about package version
        if (line.trim() === 'Warning message:' && nextLine.includes('was built under R version')) {
          i++; // Skip the next line too
          continue;
        }

        // Skip lines about package version mismatches
        if (line.includes('was built under R version')) {
          continue;
        }

        // Keep non-empty lines
        if (line.trim().length > 0) {
          filtered.push(line);
        }
      }

      filteredError = filtered.length > 0 ? filtered.join('\n') : null;
    }

    // Extract title from reportSections and send separately
    const reportTitle = reportSections.title || `Dataset: ${database}.${schema}.${tableName}`;
    // Remove title from reportSections so it doesn't appear in the UI tabs
    delete reportSections.title;

    // Return complete response
    res.json({
      success: true,
      reportSections: reportSections,
      reportTitle: reportTitle,
      code: diagnosticCode,
      output: rOutput.stdout,
      error: filteredError,
      suggestions: suggestions,
      tableName: `${database}.${schema}.${tableName}`,
      variableName: varName,
      columnMetadata: columnMetadata  // Include schema for future chat requests
    });

  } catch (error) {
    console.error('Error in load-and-report-snowflake:', error);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      error: error.message || 'Failed to load and report on Snowflake table',
      details: error.stack
    });
  }
});

/**
 * POST /api/clear-workspace
 * Clear the R workspace (for new conversations)
 */
app.post('/api/clear-workspace', async (req, res) => {
  try {
    // Delete temp workspace file if it exists
    await unlink(TEMP_WORKSPACE).catch(() => {});

    // Delete persistent workspace file if it exists
    await unlink(PERSISTENT_WORKSPACE).catch(() => {});

    console.log('R workspace cleared (temp + persistent)');
    res.json({ success: true });
  } catch (error) {
    console.error('Error clearing workspace:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Helper: Build complete code chain for reproducibility
 * Includes all code executed before and including favorited outputs
 * @param {Array} favoritedCardIds - Array of favorited card IDs
 * @param {Array} allCodeCards - All code cards in execution order
 * @returns {Array} Ordered array of code cards needed for reproducibility
 */
function buildCodeChain(favoritedCardIds, allCodeCards) {
  const orderedCards = [];
  const seenIds = new Set();

  favoritedCardIds.forEach(cardId => {
    const cardIndex = allCodeCards.findIndex(c => c.id === cardId);
    if (cardIndex >= 0) {
      // Include all code up to and including this card
      for (let i = 0; i <= cardIndex; i++) {
        if (!seenIds.has(allCodeCards[i].id)) {
          orderedCards.push(allCodeCards[i]);
          seenIds.add(allCodeCards[i].id);
        }
      }
    }
  });

  return orderedCards;
}

/**
 * Helper: Generate dataset loading code from dataset registry
 * @param {Object} datasets - Dataset registry datasets object
 * @returns {string} R code to load datasets
 */
function generateDatasetLoadCode(datasets) {
  const loadCode = [];

  for (const [name, dataset] of Object.entries(datasets)) {
    if (dataset.source === 'csv' && dataset.filename) {
      loadCode.push(`# Load CSV file (ensure ${dataset.filename} is in working directory)`);
      loadCode.push(`${name} <- read.csv("${dataset.filename}")`);
      loadCode.push('');
    } else if (dataset.source === 'snowflake' && dataset.fullTableName) {
      loadCode.push(`# Load Snowflake table: ${dataset.fullTableName}`);
      loadCode.push(`# Note: Requires Snowflake connection (see connection code in setup)`);
      loadCode.push(`# ${name} <- dbGetQuery(conn, "SELECT * FROM ${dataset.fullTableName} LIMIT 1000")`);
      loadCode.push('');
    }
  }

  return loadCode.join('\n');
}

/**
 * Helper: Build complete reproducible R script
 * @param {Object} datasetRegistry - Full dataset registry
 * @param {Array} codeChain - Ordered array of code cards
 * @returns {string} Complete R script
 */
function buildReproducibleScript(datasetRegistry, codeChain) {
  const parts = [];

  // 1. Library loading
  parts.push(`# Load required libraries
library(dplyr)
library(ggplot2)
library(tidyr)
library(scales)
`);

  // 2. Snowflake connection (if any Snowflake datasets exist)
  const hasSnowflake = Object.values(datasetRegistry.datasets || {}).some(d => d.source === 'snowflake');
  if (hasSnowflake) {
    parts.push(`# Snowflake Connection Setup (optional - uncomment and configure)
# library(DBI)
# library(odbc)
# conn <- dbConnect(odbc::odbc(),
#   Driver = "Snowflake",
#   Server = "your-account.snowflakecomputing.com",
#   UID = "your-username",
#   authenticator = "externalbrowser"
# )
`);
  }

  // 3. Dataset loading
  const datasetCode = generateDatasetLoadCode(datasetRegistry.datasets || {});
  if (datasetCode.trim()) {
    parts.push(`# Load datasets\n${datasetCode}`);
  }

  // 4. All code in execution order
  if (codeChain.length > 0) {
    parts.push(`# Analysis code`);
    parts.push(codeChain.map(card => card.code).join('\n\n'));
  }

  return parts.join('\n');
}

/**
 * Generate a report using Quarto
 * @param {string} reportsDir - Directory to save the report
 * @param {number} timestamp - Timestamp for filename
 * @param {string} title - Report title
 * @param {string} date - Report date
 * @param {Array} findings - Array of findings with plots/tables
 * @param {string} summary - Report summary
 * @returns {Promise<Object>} Object with htmlPath and htmlFilename
 */
async function generateQuartoReport(reportsDir, timestamp, title, date, findings, summary) {
  const qmdFilename = `report_${timestamp}.qmd`;
  const qmdPath = join(reportsDir, qmdFilename);
  const htmlFilename = `report_${timestamp}.html`;
  const htmlPath = join(reportsDir, htmlFilename);

  // Build Quarto markdown content
  let qmdContent = `---
title: "${title}"
date: "${date}"
format:
  html:
    theme: default
    toc: false
    embed-resources: true
---

\`\`\`{=html}
<style>
.code-section {
  margin: 20px 0;
  border: 1px solid #d0d0d0;
  border-radius: 4px;
  background: #f9fafb;
}
.code-toggle {
  padding: 12px 16px;
  cursor: pointer;
  font-size: 0.875rem;
  font-weight: 500;
  color: #374151;
  user-select: none;
  list-style: none;
}
.code-toggle::-webkit-details-marker {
  display: none;
}
.code-toggle::before {
  content: '▶';
  display: inline-block;
  margin-right: 8px;
  font-size: 0.75rem;
  transition: transform 0.2s ease;
}
details[open] .code-toggle::before {
  transform: rotate(90deg);
}
.code-toggle:hover {
  background: #f3f4f6;
}
.code-section pre {
  margin: 0;
  padding: 16px;
  background: #f5f5f5;
  color: #1f2937;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 0.8125rem;
  line-height: 1.6;
  overflow-x: auto;
  border-top: 1px solid #d0d0d0;
}
</style>
\`\`\`

`;

  // Add summary if provided
  if (summary) {
    qmdContent += `${summary}\n\n`;
  }

  // Add each finding
  for (let index = 0; index < findings.length; index++) {
    const finding = findings[index];

    // Add plots
    if (finding.plots && finding.plots.length > 0) {
      for (let plotIdx = 0; plotIdx < finding.plots.length; plotIdx++) {
        const plot = finding.plots[plotIdx];
        // Handle both object {type: "image", data: "..."} and plain string formats
        const plotData = typeof plot === 'string' ? plot : (plot?.data || '');

        // Save SVG plot to a file
        const plotFilename = `plot_${timestamp}_${index}_${plotIdx}.svg`;
        const plotPath = join(reportsDir, plotFilename);

        // Write the SVG file (using async writeFile from fs/promises)
        await writeFile(plotPath, plotData, 'utf-8');

        // Extract title from SVG if available
        const titleTextMatch = plotData.match(/<text[^>]*y=['"](?:19|20|21|22|23|24|25)['"'][^>]*>([^<]+)<\/text>/);
        let plotTitle = null;
        if (titleTextMatch && titleTextMatch[1] && !titleTextMatch[1].match(/^\d+$/)) {
          const candidate = titleTextMatch[1].trim();
          if (!candidate.includes('Visualization') && !candidate.includes('Plot Title') && !candidate.includes('ggplot')) {
            plotTitle = candidate;
          }
        }

        // Add title if found
        if (plotTitle) {
          qmdContent += `## ${plotTitle}\n\n`;
        }

        // Reference the plot file
        qmdContent += `![](${plotFilename})\n\n`;

        // Add description
        if (finding.description) {
          qmdContent += `${finding.description}\n\n`;
        }
      }

      // Add code section if code exists (after plots, before tables)
      if (finding.code && finding.plots && finding.plots.length > 0) {
        qmdContent += `<details class="code-section">\n`;
        qmdContent += `<summary class="code-toggle">View Code</summary>\n\n`;
        qmdContent += `\`\`\`r\n${finding.code}\n\`\`\`\n\n`;
        qmdContent += `</details>\n\n`;
      }
    }

    // Add tables
    if (finding.tables && finding.tables.length > 0) {
      for (const table of finding.tables) {
        if (typeof table === 'object' && table !== null) {
          if (table.type === 'html') {
            // For HTML widgets, we'll need to handle differently
            // For now, just note that it's a table
            qmdContent += `*Interactive table available in HTML version*\n\n`;
          }
        } else if (typeof table === 'string') {
          // Direct HTML table - include it in a raw HTML block
          qmdContent += `\`\`\`{=html}\n${table}\n\`\`\`\n\n`;
        }
      }

      // Add description after tables
      if (finding.description) {
        qmdContent += `${finding.description}\n\n`;
      }

      // Add code section if code exists (after tables)
      if (finding.code) {
        qmdContent += `<details class="code-section">\n`;
        qmdContent += `<summary class="code-toggle">View Code</summary>\n\n`;
        qmdContent += `\`\`\`r\n${finding.code}\n\`\`\`\n\n`;
        qmdContent += `</details>\n\n`;
      }
    }
  }

  // Write the .qmd file
  await writeFile(qmdPath, qmdContent, 'utf-8');
  console.log(`✅ Created Quarto file: ${qmdFilename}`);

  // Render with Quarto
  return new Promise((resolve, reject) => {
    exec(`quarto render "${qmdPath}"`, { cwd: reportsDir }, (error, stdout, stderr) => {
      if (error) {
        console.error('Quarto render error:', stderr);
        reject(new Error(`Quarto render failed: ${error.message}`));
        return;
      }

      console.log(`✅ Quarto report rendered: ${htmlFilename}`);
      resolve({ htmlPath, htmlFilename });
    });
  });
}

/**
 * Generate a Quarto report with full reproducible code
 * @param {string} reportsDir - Directory to save the report
 * @param {number} timestamp - Timestamp for filename
 * @param {string} title - Report title
 * @param {string} date - Report date
 * @param {Array} findings - Array of findings with cardIds, headings, descriptions
 * @param {Array} codeCards - All code cards in execution order
 * @param {Object} datasetRegistry - Dataset registry with all datasets
 * @returns {Promise<Object>} Object with qmdPath and qmdFilename
 */
async function generateQuartoReportWithCode(reportsDir, timestamp, title, date, findings, codeCards, datasetRegistry) {
  const qmdFilename = `report_${timestamp}.qmd`;
  const qmdPath = join(reportsDir, qmdFilename);

  // Build code chain from favorited cards
  const favoritedCardIds = findings.map(f => f.cardId);
  const codeChain = buildCodeChain(favoritedCardIds, codeCards);

  // Start Quarto document
  let qmdContent = `---
title: "${title}"
date: "${date}"
format:
  html:
    embed-resources: true
    theme: default
    toc: false
    code-fold: false
---

## Setup

\`\`\`{r setup}
#| include: false
library(dplyr)
library(ggplot2)
library(tidyr)
library(scales)
\`\`\`
`;

  // Add Snowflake connection if needed
  const hasSnowflake = Object.values(datasetRegistry.datasets || {}).some(d => d.source === 'snowflake');
  if (hasSnowflake) {
    qmdContent += `
::: {.callout-note}
## Snowflake Connection Required

This report uses Snowflake data. Uncomment and configure the connection code below:

\`\`\`{r snowflake-connection}
#| eval: false
library(DBI)
library(odbc)
conn <- dbConnect(odbc::odbc(),
  Driver = "Snowflake",
  Server = "your-account.snowflakecomputing.com",
  UID = "your-username",
  authenticator = "externalbrowser"
)
\`\`\`
:::

`;
  }

  // Add dataset loading code
  const datasetCode = generateDatasetLoadCode(datasetRegistry.datasets || {});
  if (datasetCode.trim()) {
    qmdContent += `
\`\`\`{r load-data}
${datasetCode}
\`\`\`

`;
  }

  // Add each finding with its code
  findings.forEach((finding, idx) => {
    const card = codeCards.find(c => c.id === finding.cardId);

    if (!card) return;

    // Add heading if provided
    if (finding.heading) {
      qmdContent += `## ${finding.heading}\n\n`;
    } else {
      qmdContent += `## Analysis ${idx + 1}\n\n`;
    }

    // Add description if provided
    if (finding.description) {
      qmdContent += `${finding.description}\n\n`;
    }

    // Add the R code that generated this output
    qmdContent += `\`\`\`{r}\n${card.code}\n\`\`\`\n\n`;
  });

  // Write the .qmd file
  await writeFile(qmdPath, qmdContent, 'utf-8');
  console.log(`✅ Created Quarto file with code: ${qmdFilename}`);

  return { qmdPath, qmdFilename };
}

// Create Quarto report endpoint with HTML fallback
app.post('/api/create-quarto-report', async (req, res) => {
  try {
    console.log('='.repeat(60));
    console.log('=== /api/create-quarto-report ENDPOINT HIT ===');
    console.log('='.repeat(60));
    console.log('Request body keys:', Object.keys(req.body));
    console.log('Findings array length:', req.body.findings?.length);
    console.log('codeCards present:', !!req.body.codeCards);
    console.log('First finding structure:', JSON.stringify(req.body.findings?.[0], null, 2));
    console.log('='.repeat(60));

    const { title, date, findings, summary, codeCards } = req.body;

    if (!title || !findings) {
      return res.status(400).json({ error: 'Missing required report data (title, findings)' });
    }

    // Create reports directory if it doesn't exist
    const reportsDir = join(__dirname, 'reports');
    await mkdir(reportsDir, { recursive: true });

    // Generate filename with timestamp
    const timestamp = Date.now();
    const htmlFilename = `report_${timestamp}.html`;
    const htmlPath = join(reportsDir, htmlFilename);

    // Check if Quarto is available
    const hasQuarto = await checkQuartoAvailable();

    if (hasQuarto) {
      // Try to generate report using Quarto
      try {
        console.log('📊 Generating report with Quarto...');
        const quartoResult = await generateQuartoReport(reportsDir, timestamp, title, date, findings, summary);
        return res.json({
          success: true,
          htmlPath: quartoResult.htmlPath,
          htmlFilename: quartoResult.htmlFilename,
          method: 'quarto'
        });
      } catch (quartoError) {
        console.warn('⚠️ Quarto generation failed, falling back to HTML:', quartoError.message);
        // Fall through to HTML generation
      }
    } else {
      console.log('ℹ️ Quarto not available, using HTML generation');
    }

    // Generate narrative HTML report with embedded images
    console.log('📄 Generating narrative HTML report...');
    console.log(`Number of findings: ${findings.length}`);
    findings.forEach((finding, idx) => {
      console.log(`Finding ${idx}: ${finding.title}`);
      console.log(`  - Plots: ${finding.plots?.length || 0}`);
      console.log(`  - Tables: ${finding.tables?.length || 0}`);
      console.log(`  - Text output: ${finding.textOutput ? 'Yes' : 'No'}`);
      if (finding.plots?.length > 0) {
        console.log(`  - First plot type: ${typeof finding.plots[0]}`);
        console.log(`  - First plot is array: ${Array.isArray(finding.plots[0])}`);
        if (typeof finding.plots[0] === 'string') {
          console.log(`  - String length: ${finding.plots[0].length}, starts with: ${finding.plots[0].substring(0, 50)}`);
        } else {
          console.log(`  - Not a string! Value: ${JSON.stringify(finding.plots[0]).substring(0, 200)}`);
        }
      }
    });

    // Generate findings sections
    const findingsHTML = findings.map((finding, index) => {
      console.log(`[HTML Export] Finding ${index}:`, {
        hasCode: !!finding.code,
        codeLength: finding.code?.length || 0,
        codePreview: finding.code?.substring(0, 50) || 'no code'
      });

      let sectionHTML = `
      <div class="finding">`;

      // Add plots
      if (finding.plots && finding.plots.length > 0) {
        finding.plots.forEach((plot, plotIdx) => {
          // Handle both object {type: "image", data: "..."} and plain string formats
          const plotData = typeof plot === 'string' ? plot : (plot?.data || '');

          // Extract title from ggplot SVG - the title is in a <text> element with specific positioning
          // Look for text elements near the top of the chart (y coordinate around 19-25)
          let plotTitle = null;

          // Try to find the main title text element
          const titleTextMatch = plotData.match(/<text[^>]*y=['"](?:19|20|21|22|23|24|25)['"'][^>]*>([^<]+)<\/text>/);
          if (titleTextMatch && titleTextMatch[1] && !titleTextMatch[1].match(/^\d+$/)) {
            const candidate = titleTextMatch[1].trim();
            // Only use if it's not a generic or technical description
            if (!candidate.includes('Visualization') && !candidate.includes('Plot Title') && !candidate.includes('ggplot')) {
              plotTitle = candidate;
            }
          }

          // Only show title if we found a real one from ggplot
          if (plotTitle) {
            sectionHTML += `
        <h2 class="plot-title">${plotTitle}</h2>`;
          }

          sectionHTML += `
        <div class="plot-container">
          ${plotData}
        </div>`;

          // Always add descriptive paragraph after plot
          if (finding.description) {
            sectionHTML += `
        <p class="plot-description">${finding.description}</p>`;
          }
        });
      }

      // Add tables if they exist (without heading)
      if (finding.tables && finding.tables.length > 0) {
        console.log(`Finding has ${finding.tables.length} tables`);
        finding.tables.forEach((table, tableIdx) => {
          console.log(`Table ${tableIdx}:`, typeof table, table?.type);
          console.log(`Table ${tableIdx} full structure:`, JSON.stringify(table, null, 2));

          // Handle different table formats
          if (typeof table === 'object' && table !== null) {
            if (table.type === 'html') {
              // HTML widget table (gt, formattable, etc.) - embed as iframe
              const widgetUrl = table.url || table.data;
              console.log(`Rendering HTML widget table with URL: ${widgetUrl}`);
              sectionHTML += `
            <div class="table-container">
              <iframe src="${widgetUrl}" style="width: 100%; min-height: 400px; border: none;"></iframe>
            </div>`;
            } else {
              // Unknown object type
              console.warn(`Unknown table object type:`, table);
              sectionHTML += `
            <div class="table-container">
              <div class="error">Unknown table format: ${JSON.stringify(table)}</div>
            </div>`;
            }
          } else if (typeof table === 'string') {
            // Direct HTML string
            console.log(`Rendering direct HTML table (${table.length} chars)`);
            sectionHTML += `
            <div class="table-container">
              ${table}
            </div>`;
          } else {
            console.warn(`Unexpected table type: ${typeof table}`, table);
          }
        });

        // Add description after tables (similar to plots)
        if (finding.description) {
          sectionHTML += `
        <p class="plot-description">${finding.description}</p>`;
        }
      }

      // Add collapsible code section if code exists in the finding
      if (finding.code) {
        console.log(`[HTML Export] Adding code section for finding ${index}`);
        // Escape HTML in code
        const escapedCode = finding.code
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#039;');

        sectionHTML += `
        <details class="code-section">
          <summary class="code-toggle">View Code</summary>
          <pre class="code-block"><code>${escapedCode}</code></pre>
        </details>`;
      } else {
        console.log(`[HTML Export] NO CODE for finding ${index} - finding.code is:`, finding.code);
      }

      sectionHTML += `
      </div>`;

      return sectionHTML;
    }).join('\n');

    const fullHTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <style>
    html {
      background: #edeff0;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', 'Oxygen', 'Ubuntu', 'Cantarell', sans-serif;
      line-height: 1.7;
      max-width: 960px;
      margin: 0 auto;
      padding: 40px 60px;
      color: #1a1a1a;
      background: #ffffff;
    }
    h1 {
      color: #000000;
      margin: 0 0 8px 0;
      font-size: 2rem;
      font-weight: 600;
      line-height: 1.3;
    }
    .date {
      color: #6b6b6b;
      font-size: 0.875rem;
      padding-bottom: 16px;
      border-bottom: 1px solid #e0e0e0;
      margin-bottom: 24px;
    }
    .summary {
      color: #4a4a4a;
      font-size: 0.9375rem;
      line-height: 1.6;
      margin: 24px 0;
    }
    .finding {
      margin-bottom: 48px;
    }
    .plot-title {
      color: #000000;
      font-size: 1.5rem;
      font-weight: 600;
      margin: 32px 0 20px 0;
    }
    .plot-container {
      margin: 20px 0;
      padding: 20px;
      background: #ffffff;
      border: 1px solid #d0d0d0;
      border-radius: 4px;
      display: flex;
      justify-content: center;
      align-items: center;
    }
    .plot-container svg {
      max-width: 100%;
      height: auto;
    }
    .plot-description {
      color: #4a4a4a;
      font-size: 0.9375rem;
      line-height: 1.6;
      margin: 20px 0;
    }
    h3 {
      color: #000000;
      font-size: 1.25rem;
      font-weight: 600;
      margin-top: 32px;
      margin-bottom: 16px;
    }
    .table-container {
      margin: 20px 0;
      overflow-x: auto;
    }
    .table-container table {
      border-collapse: collapse;
      width: 100%;
    }
    .table-container th,
    .table-container td {
      padding: 0.5rem;
      text-align: left;
      border: 1px solid #e2e8f0;
    }
    .table-container th {
      background: #f7fafc;
      font-weight: 600;
    }
    .code-section {
      margin: 20px 0;
      border: 1px solid #d0d0d0;
      border-radius: 4px;
      background: #f9fafb;
    }
    .code-toggle {
      padding: 12px 16px;
      cursor: pointer;
      font-size: 0.875rem;
      font-weight: 500;
      color: #374151;
      user-select: none;
      list-style: none;
    }
    .code-toggle::-webkit-details-marker {
      display: none;
    }
    .code-toggle::before {
      content: '▶';
      display: inline-block;
      margin-right: 8px;
      font-size: 0.75rem;
      transition: transform 0.2s ease;
    }
    details[open] .code-toggle::before {
      transform: rotate(90deg);
    }
    .code-toggle:hover {
      background: #f3f4f6;
    }
    .code-block {
      margin: 0;
      padding: 16px;
      background: #f5f5f5;
      color: #1f2937;
      font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
      font-size: 0.8125rem;
      line-height: 1.6;
      overflow-x: auto;
      border-top: 1px solid #d0d0d0;
    }
    .code-block code {
      background: none;
      padding: 0;
      color: inherit;
    }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="date">${date}</div>
  ${summary ? `<div class="summary">${summary}</div>` : ''}
  ${findingsHTML}
</body>
</html>`;

    // Write HTML file
    await writeFile(htmlPath, fullHTML, 'utf-8');

    console.log(`✅ HTML report created: ${htmlFilename}`);

    res.json({
      success: true,
      htmlPath: htmlPath,
      htmlFilename: htmlFilename,
      method: 'html'
    });
  } catch (error) {
    console.error('Error creating report:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Export Quarto report with full reproducible code
 */
app.post('/api/export-quarto', async (req, res) => {
  try {
    const { title, date, findings, codeCards, datasetRegistry } = req.body;

    if (!title || !findings || !codeCards || !datasetRegistry) {
      return res.status(400).json({ error: 'Missing required export data' });
    }

    // Create reports directory if it doesn't exist
    const reportsDir = join(__dirname, 'reports');
    await mkdir(reportsDir, { recursive: true });

    // Generate filename with timestamp
    const timestamp = Date.now();
    const { qmdPath, qmdFilename } = await generateQuartoReportWithCode(
      reportsDir, timestamp, title, date, findings, codeCards, datasetRegistry
    );

    console.log(`✅ Quarto export complete: ${qmdFilename}`);

    res.json({
      success: true,
      qmdPath: qmdPath,
      qmdFilename: qmdFilename,
      downloadUrl: `/reports/${qmdFilename}`
    });
  } catch (error) {
    console.error('Error exporting Quarto report:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Export Jupyter notebook with full reproducible code
 */
app.post('/api/export-jupyter', async (req, res) => {
  try {
    const { title, findings, codeCards, datasetRegistry } = req.body;

    if (!title || !findings || !codeCards || !datasetRegistry) {
      return res.status(400).json({ error: 'Missing required export data' });
    }

    // Create reports directory if it doesn't exist
    const reportsDir = join(__dirname, 'reports');
    await mkdir(reportsDir, { recursive: true });

    // Build code chain from favorited cards
    const favoritedCardIds = findings.map(f => f.cardId);
    const codeChain = buildCodeChain(favoritedCardIds, codeCards);

    // Build notebook structure
    const cells = [];

    // Title cell
    cells.push({
      cell_type: 'markdown',
      metadata: {},
      source: [`# ${title}\n`]
    });

    // Setup cell - libraries
    cells.push({
      cell_type: 'markdown',
      metadata: {},
      source: ['## Setup\n']
    });

    cells.push({
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      source: [
        'library(dplyr)\n',
        'library(ggplot2)\n',
        'library(tidyr)\n',
        'library(scales)'
      ],
      outputs: []
    });

    // Snowflake connection if needed
    const hasSnowflake = Object.values(datasetRegistry.datasets || {}).some(d => d.source === 'snowflake');
    if (hasSnowflake) {
      cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: [
          '### Snowflake Connection (Optional)\n',
          '\n',
          'Uncomment and configure the connection code below if using Snowflake data:\n'
        ]
      });

      cells.push({
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        source: [
          '# library(DBI)\n',
          '# library(odbc)\n',
          '# conn <- dbConnect(odbc::odbc(),\n',
          '#   Driver = "Snowflake",\n',
          '#   Server = "your-account.snowflakecomputing.com",\n',
          '#   UID = "your-username",\n',
          '#   authenticator = "externalbrowser"\n',
          '# )\n'
        ],
        outputs: []
      });
    }

    // Dataset loading
    const datasetCode = generateDatasetLoadCode(datasetRegistry.datasets || {});
    if (datasetCode.trim()) {
      cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: ['## Load Datasets\n']
      });

      cells.push({
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        source: datasetCode.split('\n').map(line => line + '\n'),
        outputs: []
      });
    }

    // Analysis cells - one markdown + code cell per finding
    findings.forEach((finding, idx) => {
      const card = codeCards.find(c => c.id === finding.cardId);
      if (!card) return;

      // Section heading
      const heading = finding.heading || `Analysis ${idx + 1}`;
      cells.push({
        cell_type: 'markdown',
        metadata: {},
        source: [`## ${heading}\n`]
      });

      // Description if provided
      if (finding.description) {
        cells.push({
          cell_type: 'markdown',
          metadata: {},
          source: finding.description.split('\n').map(line => line + '\n')
        });
      }

      // Code cell
      cells.push({
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        source: card.code.split('\n').map(line => line + '\n'),
        outputs: []
      });
    });

    // Build final notebook structure
    const notebook = {
      cells,
      metadata: {
        kernelspec: {
          display_name: 'R',
          language: 'R',
          name: 'ir'
        },
        language_info: {
          name: 'R',
          version: '4.5.0',
          mimetype: 'text/x-r-source',
          file_extension: '.r'
        }
      },
      nbformat: 4,
      nbformat_minor: 5
    };

    // Save to file
    const timestamp = Date.now();
    const filename = `report_${timestamp}.ipynb`;
    const filepath = join(reportsDir, filename);
    await writeFile(filepath, JSON.stringify(notebook, null, 2), 'utf-8');

    console.log(`✅ Jupyter notebook export complete: ${filename}`);

    res.json({
      success: true,
      filename: filename,
      filepath: filepath,
      downloadUrl: `/reports/${filename}`
    });
  } catch (error) {
    console.error('Error exporting Jupyter notebook:', error);
    res.status(500).json({ error: error.message });
  }
});

// Serve reports directory
app.use('/reports', express.static(join(__dirname, 'reports')));

// ==================== WORKSPACE PERSISTENCE ====================

/**
 * Save R workspace to persistent storage on shutdown
 */
async function saveWorkspaceOnShutdown() {
  console.log('\n💾 Saving R workspace...');
  try {
    // Ensure temp directory exists
    await mkdir(TEMP_DIR, { recursive: true });

    // Check if temp workspace exists
    if (existsSync(TEMP_WORKSPACE)) {
      // Copy temp workspace to persistent location
      const copyCode = `file.copy("${TEMP_WORKSPACE.replace(/\\/g, '/')}", "${PERSISTENT_WORKSPACE.replace(/\\/g, '/')}", overwrite = TRUE)`;
      await executeRWorkspaceOperation(copyCode);
      console.log('✓ R workspace saved to persistent storage');
    } else {
      console.log('No workspace to save (session was empty)');
    }
  } catch (error) {
    console.error('Error saving workspace:', error.message);
  }
}

/**
 * Load R workspace from persistent storage on startup
 */
async function loadWorkspaceOnStartup() {
  try {
    // Ensure temp directory exists
    await mkdir(TEMP_DIR, { recursive: true });

    // Check if persistent workspace exists
    if (existsSync(PERSISTENT_WORKSPACE)) {
      console.log('📂 Restoring R workspace from previous session...');
      // Copy persistent workspace to temp location
      const copyCode = `file.copy("${PERSISTENT_WORKSPACE.replace(/\\/g, '/')}", "${TEMP_WORKSPACE.replace(/\\/g, '/')}", overwrite = TRUE)`;
      await executeRWorkspaceOperation(copyCode);
      console.log('✓ R workspace restored');
    } else {
      console.log('No previous workspace found (fresh start)');
    }
  } catch (error) {
    console.error('Error loading workspace:', error.message);
  }
}

/**
 * Handle graceful shutdown
 */
async function handleShutdown(signal) {
  console.log(`\n\n🛑 Received ${signal}, shutting down gracefully...`);
  await saveWorkspaceOnShutdown();
  process.exit(0);
}

// Register shutdown handlers
process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

// ==================== END WORKSPACE PERSISTENCE ====================

// Start server
app.listen(PORT, async () => {
  console.log(`\n🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📡 Ready to proxy requests to Anthropic API`);
  console.log(`🔧 R code execution endpoint available\n`);

  // Restore workspace from previous session if it exists
  await loadWorkspaceOnStartup();
  console.log('');
});
