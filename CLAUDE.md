# 3Panel Interactive Suggestions & Dataset Tracking

This document describes how 3Panel's interactive suggestions and automatic dataset tracking work.

## Table of Contents

1. [Interactive Suggestions Overview](#interactive-suggestions-overview)
2. [How Interactive Elements Are Created](#how-interactive-elements-are-created)
3. [Dataset Naming Convention](#dataset-naming-convention)
4. [Automatic Dataset Tracking](#automatic-dataset-tracking)
5. [Metadata Flow](#metadata-flow)
6. [Troubleshooting](#troubleshooting)

---

## Interactive Suggestions Overview

Interactive suggestions allow users to modify values directly in suggestion text before submitting. This provides a powerful way to explore alternatives without retyping prompts.

### Types of Interactive Elements

1. **Categorical Values** - Dropdown lists for swapping country names, species, etc.
2. **Numeric Ranges** - Dual-thumb sliders for year ranges like "1950 to 2020"
3. **Single Numbers** - Single sliders for values like ages or counts

### Example

```
Suggestion: "Create a line plot for Japan from 1950 to 2020"

Interactive:  - "Japan" → hover shows dropdown with [China, India, USA]
              - "1950 to 2020" → hover shows dual-thumb slider (1800-2100)
```

---

## How Interactive Elements Are Created

Interactive suggestions are generated server-side in `server.js` using dataset metadata.

### 1. Categorical Values (`server.js:881-1043`)

**Criteria for making a value interactive:**

```javascript
// Must pass ALL these checks:
1. Value exists in a categorical column (2-250 unique values)
2. Value is NOT a common English word ("and", "to", "for", etc.)
3. Value is at least 4 characters long
4. NOT in a parenthetical list: (Japan, China, India)
5. NOT in a GROUP BY operation: "across countries"
6. NOT in aggregation language: "by country", "for each continent"
```

**Example matches:**
- ✅ "Create a plot for **Japan**" → "Japan" becomes interactive
- ✅ "Compare **China** with other countries" → "China" becomes interactive
- ❌ "Plot across all countries" → No value becomes interactive (aggregation)
- ❌ "Countries (Japan, China, India)" → No values (parenthetical list)

### 2. Numeric Ranges (`server.js:1068-1118`)

**NEW APPROACH (2026-01-07): Claude Explicitly Specifies Column**

Instead of the backend guessing which column a numeric range refers to, **Claude now explicitly declares it** when generating suggestions.

**How It Works:**

1. **Claude generates suggestion** with numeric range JSON:
```json
{
  "text": "Create a line plot showing trends from 1990 to 2020",
  "interactive": {
    "type": "numeric-range",
    "column": "year",           // ← Claude specifies the column!
    "minValue": 1990,
    "maxValue": 2020
  }
}
```

2. **Backend validates and processes:**
   - Checks if column exists in metadata
   - Validates column is numeric type
   - Finds range text in suggestion for positioning
   - Creates dual-thumb slider with correct bounds

3. **Result:** Reliable, accurate range sliders

**System Prompt Instructions ([server.js:2324-2340](server.js#L2324-L2340)):**
```
OPTION 2 - NUMERIC RANGE:
* Include a numeric range in your suggestion (e.g., "from 1990 to 2020")
* ⚠️ CRITICAL: You MUST explicitly specify which COLUMN the range refers to
* Provide interactive object with these fields:
  - "type": "numeric-range"
  - "column": the EXACT column name from the schema
  - "minValue": the minimum value in your suggestion
  - "maxValue": the maximum value in your suggestion
```

**Advantages over old text-parsing approach:**
- ✅ No ambiguity when multiple columns could match
- ✅ Claude knows context (e.g., "1990 to 2020" refers to `year`, not `life_expectancy`)
- ✅ Works with any column name (not just "year")
- ✅ Reliable across all datasets

**Fallback behavior:**
- If Claude doesn't specify `column`, backend falls back to old text-parsing logic
- Ensures backwards compatibility

**Example matches:**
- ✅ "Plot from **1990 to 2020**" with `column: "year"` → Year slider (1800-2100)
- ✅ "Ages **25 to 65**" with `column: "age"` → Age slider (0-100)
- ✅ "Life expectancy between **50 and 80**" with `column: "life_expectancy"` → LE slider (1-95)

### 3. Single Numeric Values (`server.js:1124-1196`)

Less commonly used. Requires confident column match via:
- Column name appears near the value
- Value falls within column's bounds
- Context suggests filtering/selection (not aggregation)

---

## Dataset Naming Convention

### The `_tidy` Suffix Rule

**When converting data to tidy format, always append `_tidy` to the dataset name:**

```r
# ✅ CORRECT
lex_tidy <- lex %>%
  pivot_longer(cols = starts_with("X"),
               names_to = "year",
               values_to = "life_expectancy")

# ❌ WRONG - overwrites original
lex <- lex %>% pivot_longer(...)

# ❌ WRONG - doesn't use _tidy suffix
lex_long <- lex %>% pivot_longer(...)
```

### Why This Matters

1. **Preserves original data** - You can always reference the wide format
2. **Automatic tracking** - System detects `_tidy` datasets and switches to them
3. **Predictable naming** - Always know which dataset is active
4. **Better suggestions** - Tidy datasets have the right columns for analysis

### Implementation

**System Prompt (`server.js:679-703`):**
```
===== CRITICAL NAMING CONVENTION FOR TIDY TRANSFORMATIONS =====

When generating R code that converts data to tidy format:

REQUIRED BEHAVIOR:
1. ALWAYS create a NEW dataset with "_tidy" appended to the original name
2. DO NOT overwrite the original dataset

CORRECT EXAMPLES:
✓ lex_tidy <- lex %>% pivot_longer(...)
✓ population_tidy <- population %>% pivot_longer(...)
```

---

## Automatic Dataset Tracking

### How It Works

When you transform data to tidy format, the system automatically:

1. **Detects** the `_tidy` suffix during R code execution
2. **Refreshes** metadata for the new dataset (columns, types, values)
3. **Switches** the active dataset to the tidy version
4. **Uses** the tidy dataset for future code generation and suggestions

### Step-by-Step Flow

```
1. Load Data
   User: Load lex.csv
   System: Creates dataset "lex" with columns [geo, name, X1800, X1801, ..., X2100]
   Active Dataset: "lex"

2. Tidy Transformation
   User: "Convert to tidy format"
   Claude: Generates code → lex_tidy <- lex %>% pivot_longer(...)
   System: Executes code

3. Auto-Detection (server.js:1802)
   Code: const isTidyDataset = detectedDataset.endsWith('_tidy');
   Result: isTidyDataset = true

4. Metadata Refresh (server.js:1603-1817)
   System: Runs str(lex_tidy), extracts columns, values, min/max
   Result: Metadata shows [geo, name, year, life_expectancy]

5. Auto-Switch (src/App.jsx:1296-1319)
   Frontend: Receives shouldBecomeActive: true
   Code: activeDataset = shouldBecomeActive ? 'lex_tidy' : prev.activeDataset
   Active Dataset: "lex_tidy" ✓

6. Future Code Generation (server.js:120-130)
   System Prompt: "🎯 ACTIVE DATASET: lex_tidy"
   Claude: Uses "lex_tidy" in all generated R code

7. Interactive Suggestions
   System: Has "year" column in metadata (min: 1800, max: 2100)
   Result: Year ranges become interactive! ✓
```

### Key Code Locations

**Backend Detection:**
```javascript
// server.js:1802 - Detect tidy datasets
const isTidyDataset = detectedDataset.endsWith('_tidy');

result.updatedMetadata = {
  datasetName: detectedDataset,
  columnMetadata: columnMetadata,
  shouldBecomeActive: isTidyDataset,  // Auto-switch flag
  hash: JSON.stringify({...})
};
```

**Frontend Auto-Switch:**
```javascript
// src/App.jsx:1300-1303 - Auto-switch active dataset
setDatasetRegistry(prev => ({
  ...prev,
  activeDataset: shouldBecomeActive ? datasetName : prev.activeDataset,
  datasets: {...}
}));
```

**Active Dataset in Prompts:**
```javascript
// server.js:120-130 - Include in system prompt
schemaInfo = `
CURRENT DATASET SCHEMA:
🎯 ACTIVE DATASET: ${activeDatasetName}
Numeric columns: year, life_expectancy
Categorical columns: name, geo

⚠️ CRITICAL: When writing R code, you MUST use "${activeDatasetName}".
`;
```

---

## Metadata Flow

### From R Execution to Interactive Suggestions

```
┌─────────────────────────────────────────────────────────┐
│ 1. R Code Execution                                     │
│    User runs: lex_tidy <- lex %>% pivot_longer(...)    │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ 2. Dataset Detection (server.js:1286-1301)             │
│    Pattern match: /^(\w+)\s*<-/                        │
│    Result: detectedDataset = "lex_tidy"                │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ 3. Metadata Refresh (server.js:1635-1743)              │
│    Runs R code:                                         │
│      str(lex_tidy)                                      │
│      summary(lex_tidy)                                  │
│    Extracts:                                            │
│      - Column names: [geo, name, year, life_expectancy]│
│      - Categorical values: name → [China, India, ...]  │
│      - Numeric ranges: year → min:1800, max:2100       │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ 4. Frontend Registry Update (src/App.jsx:1300-1312)    │
│    datasetRegistry.activeDataset = "lex_tidy"          │
│    datasetRegistry.datasets["lex_tidy"] = {            │
│      columnMetadata: [{name:"year",min:1800,max:2100}] │
│    }                                                    │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ 5. Next API Call (src/App.jsx:1153-1160)               │
│    sendMessageToClaude(                                 │
│      cleanColumnMetadata,  // From lex_tidy            │
│      activeDatasetName: "lex_tidy"                     │
│    )                                                    │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ 6. Claude Response with Suggestions                     │
│    Claude sees: ACTIVE DATASET: lex_tidy               │
│                 Numeric columns: year (1800-2100)       │
│    Generates suggestion:                                │
│      "Plot from 1950 to 2020 for Japan"                │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ 7. Interactive Elements Added (server.js:881-1196)     │
│    Categorical: "Japan" → matches "name" column         │
│    Range: "1950 to 2020" → matches "year" column       │
│                                                         │
│    Result: {                                            │
│      text: "Plot from 1950 to 2020 for Japan",         │
│      interactive: {                                     │
│        value: "Japan",                                  │
│        options: ["China", "India", "Japan", "USA"]     │
│      }                                                  │
│    }                                                    │
└─────────────────┬───────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────┐
│ 8. Render Interactive UI (InteractiveSuggestion.jsx)   │
│    User hovers "Japan" → dropdown appears               │
│    User hovers "1950 to 2020" → dual slider appears    │
│    User modifies values → text updates                  │
│    User clicks → submits modified suggestion            │
└─────────────────────────────────────────────────────────┘
```

---

## Troubleshooting

### Issue: Year ranges not interactive

**Problem:** Suggestions show year ranges but they're not interactive.

**Cause:** The active dataset doesn't have a `year` column in metadata.

**Check:**
1. Open browser console
2. Look for: `[/api/chat] Has "year" column: false`
3. Check active dataset: `[/api/chat] activeDatasetName: data`

**Solution:**
- Ensure tidy transformation creates `lex_tidy` (not overwrites `lex`)
- Re-run the tidy transformation code
- Watch for: `[EXECUTE] Auto-switching active dataset to 'lex_tidy'`

### Issue: Countries not interactive

**Problem:** Country names in suggestions aren't interactive.

**Causes:**
1. ~~Low cardinality filter blocking them~~ (FIXED)
2. Suggestion text uses aggregation language
3. Values in parenthetical lists

**Check server logs:**
```bash
tail -100 /tmp/claude/.../server.log | grep -i "skipping"
```

**Common blocks:**
- `Skipping "China" - in parenthetical list`
- `Skipping "USA" - part of GROUP BY operation`
- `Skipping "India" - strong aggregation language`

**Solution:**
- Rephrase suggestions to be more specific:
  - ❌ "Compare life expectancy across all countries"
  - ✅ "Create a line plot for Japan to visualize trends"

### Issue: Wrong dataset used in generated code

**Problem:** Claude generates code using `lex` instead of `lex_tidy`.

**Cause:** Active dataset not being sent to API.

**Check:**
1. Browser console: Look for API payload
2. Server logs: `[/api/chat] activeDatasetName: lex_tidy`

**Solution:**
- Refresh the page (frontend state may be stale)
- Re-run tidy transformation if needed
- Check `datasetRegistry.activeDataset` in React DevTools

### Issue: Metadata overwritten by intermediate results

**Problem:** Created `milestone_70 <- lex_tidy %>% filter(...)` and lost `lex_tidy` metadata.

**Status:** FIXED - System now only refreshes metadata for detected dataset, not active dataset.

**Behavior now:**
- Creating `milestone_70` will NOT overwrite `lex_tidy` metadata
- Only creating a new `*_tidy` dataset will switch active dataset
- Intermediate results are tracked but don't become active

---

## Implementation Checklist

When modifying the interactive suggestions system:

### Adding new interactive element types:

- [ ] Update `server.js` suggestion processing (lines 881-1196)
- [ ] Add pattern matching for the new type
- [ ] Add column metadata matching logic
- [ ] Update `InteractiveSuggestion.jsx` to render the UI
- [ ] Add CSS styles in `index.css`
- [ ] Test with real dataset

### Modifying semantic filters:

- [ ] Update filters in `server.js:934-1008`
- [ ] Add logging for debugging: `console.log('[/api/chat] Skipping...')`
- [ ] Test with various suggestion phrasings
- [ ] Document the new filter behavior in this file

### Changing dataset tracking:

- [ ] Update detection logic in `server.js:1283-1301`
- [ ] Update auto-switch logic in `src/App.jsx:1300-1319`
- [ ] Update system prompt in `server.js` to match new convention
- [ ] Test full workflow: load → transform → generate code
- [ ] Update this documentation

---

## File Reference

### Key Files

| File | Purpose | Lines |
|------|---------|-------|
| `server.js` | Backend logic for suggestions & dataset tracking | 79-3180 |
| `src/App.jsx` | Frontend dataset registry & code execution | 52-1350 |
| `src/components/InteractiveSuggestion.jsx` | Interactive UI component | 1-416 |
| `src/utils/claudeApi.js` | API communication with active dataset | 20-35 |
| `src/index.css` | Styles for interactive elements | 240-420 |

### Important Functions

**Backend:**
- `app.post('/api/chat')` - Main API endpoint with suggestion generation
- `app.post('/api/execute-r')` - R code execution with metadata refresh

**Frontend:**
- `handleSendMessage()` - Sends messages with active dataset
- `executeRCode()` - Executes R code and updates registry
- `InteractiveSuggestion` - Renders interactive suggestion UI

---

## Future Enhancements

Potential improvements to consider:

1. **Smart dataset switching** - Detect when user references old dataset and offer to switch
2. **Multi-dataset support** - Allow multiple datasets to be active simultaneously
3. **Dataset visualization** - Show dataset tree/graph in UI
4. **Undo/redo** - Track dataset transformations and allow reverting
5. **Interactive validation** - Warn when suggestion values don't match current dataset
6. **Custom interactive types** - Allow users to define their own interactive elements
7. **Suggestion templates** - Pre-built suggestion patterns for common analyses

---

Last updated: 2026-01-05
