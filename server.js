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
 * POST /api/chat
 * Proxy endpoint for Claude API requests
 *
 * Body:
 * - apiKey: Anthropic API key
 * - messages: Array of conversation messages
 */
app.post('/api/chat', async (req, res) => {
  try {
    const { apiKey, messages, suggestionsEnabled, recentPlots, columnMetadata } = req.body;

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

      schemaInfo = `\n\nCURRENT DATASET SCHEMA:
Numeric columns: ${numericColumns.join(', ') || 'none'}
Categorical columns with values:
${categoricalColumnsWithValues.map(c => `  - ${c}`).join('\n') || 'none'}

⚠️  CRITICAL: When writing R code that references column names, you MUST use the EXACT column names shown above.
DO NOT infer, guess, or fabricate column names. For example, if you see "TARGET: [Iris-setosa, ...]", the column name is TARGET, NOT "SPECIES" or any other name you might infer from the values.`;
    }

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
5. When analyzing data that was loaded earlier, just use the variable name directly

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

CRITICAL - DATASET VARIABLE NAMING CONVENTION:
When datasets are loaded via the load-data button, they follow a strict naming convention:
- Variable name = filename without the .csv extension, with ALL special characters (hyphens, spaces, dots, etc.) replaced by underscores
- Example: "lex.csv" → variable is "lex"
- Example: "population_data.csv" → variable is "population_data"
- Example: "my-dataset.csv" → variable is "my_dataset" (hyphen becomes underscore)
- Example: "Nutrition__Physical_Activity__and_Obesity_-_Behavioral_Risk_Factor_Surveillance_System.csv" → variable is "Nutrition__Physical_Activity__and_Obesity___Behavioral_Risk_Factor_Surveillance_System"

When the user asks you to work with a dataset:
1. LOOK BACK in the conversation history for when the dataset was loaded
2. FIND the filename (e.g., "lex.csv" or "my-data.csv")
3. REMOVE the .csv extension and replace ALL special characters with underscores (e.g., "lex" or "my_data")
4. USE that variable name in your code

Example:
User loads: "lex.csv"
Variable is: lex
User asks: "Pivot lex to long format"
You generate: "lex_long <- lex %>% pivot_longer(...)"  <-- Use lex, not lex_data!

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

IMPORTANT: After providing your response and R code, if the user's request involved analyzing a specific dataset, you MUST include exactly 4 suggestions for further analysis. Format these suggestions at the end of your response like this:

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
8. WHEN TO PROVIDE SUGGESTIONS:
   - Provide suggestions when the user explicitly names a dataset (e.g., "mtcars", "iris_data", "lex")
   - ALSO provide suggestions when the user says "the dataset", "this data", "the data", etc. and you are actively working with a dataset from the conversation history
   - Do NOT provide suggestions for general questions or tasks not involving dataset analysis (e.g., "how do I connect to Snowflake?")

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

===== END TIDY FORMAT REQUIREMENT =====`;
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
      const suggestionsMatch = responseText.match(/\*\*Suggestions for further analysis:\*\*\s*([\s\S]*?)(?:\n\n|$)/);

      if (suggestionsMatch) {
        const suggestionsText = suggestionsMatch[1];
        const suggestionLines = suggestionsText
          .split('\n')
          .filter(line => line.trim().startsWith('-'))
          .map(line => line.replace(/^-\s*/, '').trim())
          .filter(s => s.length > 0);

        // For now, return as simple strings - interactive metadata would require
        // knowing the dataset schema, which we don't have in regular chat
        parsedSuggestions = suggestionLines;

        console.log('[/api/chat] Extracted', parsedSuggestions.length, 'suggestions from response');
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
    const { code, autoFormatTabular = true } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({
        error: 'R code is required'
      });
    }

    console.log('Auto format tabular:', autoFormatTabular);

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

${baseFilename} <- read.csv("${filename}")

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
    unique_vals <- unique(na.omit(col_data))
    n_unique <- length(unique_vals)
    # Only show if there are 2-20 unique values (truly categorical)
    if (n_unique >= 2 && n_unique <= 20) {
      cat(paste0("$ ", col_name, ": [", paste(head(unique_vals, 15), collapse = ", "),
                 if(n_unique > 15) "..." else "", "]\\n"))
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
        const valueMatches = categoricalText.matchAll(/\$ (\w+): \[(.*?)\]/g);
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
${suggestionsEnabled ? `
- For suggestions: provide 2-4 specific, actionable prompts for CHART/PLOT analysis only
- If data is NOT in tidy format, FIRST suggestion must be a specific prompt to convert it using pivot_longer()
- Each suggestion MUST be fully executable with specific column names
- For plot suggestions, you MAY mark ONE categorical VALUE as interactive:
  * Include a specific categorical value in your suggestion (e.g., "for Iris-setosa" or "in Canada")
  * ONLY make actual categorical VALUES interactive (like "Iris-setosa"), NEVER column names, NEVER other words
  * Provide the interactive object with ONLY three fields:
    - "value": the exact categorical value text (e.g., "Iris-setosa")
    - "context": brief label (e.g., "species", "country", "year")
    - "options": array of alternative values from the schema above
  * DO NOT calculate character positions - the server does this automatically

  CORRECT EXAMPLE:
  {
    "text": "Create a box plot of SEPAL_LENGTH_CM for Iris-setosa",
    "interactive": {
      "value": "Iris-setosa",
      "context": "species",
      "options": ["Iris-setosa", "Iris-versicolor", "Iris-virginica"]
    }
  }

  WRONG EXAMPLES:
  ✗ "value": "species" - this is a column name, not a categorical value!
  ✗ "value": "distributions" - this is not a categorical value!

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
        structure: reportData.structure || '',
        tidyFormat: reportData.tidyFormat || '',
        missingData: reportData.missingData || '',
        subject: reportData.subject || '',
        insights: reportData.insights || ''
      };
      suggestions = reportData.suggestions || [];

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

            // Calculate positions and add them
            sug.interactive.start = valueIndex;
            sug.interactive.end = valueIndex + value.length;

            console.log(`  ✓ Valid - added positions ${sug.interactive.start}-${sug.interactive.end}`);
          }
        }

        // Filter out null suggestions (those with invalid column names)
        suggestions = suggestions.filter(s => s !== null);
        console.log(`[CSV] After validation: ${suggestions.length} suggestions remain`);
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

    // Return complete response
    res.json({
      success: true,
      reportSections: reportSections,
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
    unique_vals <- unique(na.omit(col_data))
    n_unique <- length(unique_vals)
    # Only show if there are 2-20 unique values (truly categorical)
    if (n_unique >= 2 && n_unique <= 20) {
      cat(paste0("$ ", col_name, ": [", paste(head(unique_vals, 15), collapse = ", "),
                 if(n_unique > 15) "..." else "", "]\\n"))
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
        const valueMatches = categoricalText.matchAll(/\$ (\w+): \[(.*?)\]/g);
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
${suggestionsEnabled ? `
- For suggestions: provide 2-4 specific, actionable prompts for CHART/PLOT analysis only
- If data is NOT in tidy format, FIRST suggestion must be a specific prompt to convert it using pivot_longer()
- Each suggestion MUST be fully executable with specific column names
- For plot suggestions, you MAY mark ONE categorical VALUE as interactive:
  * Include a specific categorical value in your suggestion (e.g., "for Iris-setosa" or "in Canada")
  * ONLY make actual categorical VALUES interactive (like "Iris-setosa"), NEVER column names, NEVER other words
  * Provide the interactive object with ONLY three fields:
    - "value": the exact categorical value text (e.g., "Iris-setosa")
    - "context": brief label (e.g., "species", "country", "year")
    - "options": array of alternative values from the schema above
  * DO NOT calculate character positions - the server does this automatically

  CORRECT EXAMPLE:
  {
    "text": "Create a box plot of SEPAL_LENGTH_CM for Iris-setosa",
    "interactive": {
      "value": "Iris-setosa",
      "context": "species",
      "options": ["Iris-setosa", "Iris-versicolor", "Iris-virginica"]
    }
  }

  WRONG EXAMPLES:
  ✗ "value": "species" - this is a column name, not a categorical value!
  ✗ "value": "distributions" - this is not a categorical value!

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
        structure: reportData.structure || '',
        tidyFormat: reportData.tidyFormat || '',
        missingData: reportData.missingData || '',
        subject: reportData.subject || '',
        insights: reportData.insights || ''
      };
      suggestions = reportData.suggestions || [];

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

            // Calculate positions and add them
            sug.interactive.start = valueIndex;
            sug.interactive.end = valueIndex + value.length;

            console.log(`  ✓ Valid - added positions ${sug.interactive.start}-${sug.interactive.end}`);
          }
        }

        // Filter out null suggestions (those with invalid column names)
        suggestions = suggestions.filter(s => s !== null);
        console.log(`[SNOWFLAKE] After validation: ${suggestions.length} suggestions remain`);
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

    // Return complete response
    res.json({
      success: true,
      reportSections: reportSections,
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

// Create Quarto report endpoint with HTML fallback
app.post('/api/create-quarto-report', async (req, res) => {
  try {
    const { title, date, findings, summary } = req.body;

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

// Serve reports directory
app.use('/reports', express.static(join(__dirname, 'reports')));

// Start server
app.listen(PORT, () => {
  console.log(`\n🚀 Proxy server running on http://localhost:${PORT}`);
  console.log(`📡 Ready to proxy requests to Anthropic API\n`);
  console.log(`🔧 R code execution endpoint available\n`);
});
