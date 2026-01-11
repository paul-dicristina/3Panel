import React, { useState, useEffect, useRef } from 'react';
import Split from 'split.js';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import r from 'react-syntax-highlighter/dist/esm/languages/hljs/r';
import chrome from 'react-syntax-highlighter/dist/esm/styles/hljs/atom-one-light';
import ReactMarkdown from 'react-markdown';
import ApiKeyModal from './components/ApiKeyModal';
import CodeCard from './components/CodeCard';
import DatasetReport from './components/DatasetReport';
import SnowflakeBrowserModal from './components/SnowflakeBrowserModal';
import InteractiveSuggestion from './components/InteractiveSuggestion';
import ReactiveComponent from './components/ReactiveComponent';
import { sendMessageToClaude } from './utils/claudeApi';
import { executeRCode } from './utils/rExecutor';

// Register R language for syntax highlighting
SyntaxHighlighter.registerLanguage('r', r);

/**
 * Main App Component
 *
 * Three-panel layout:
 * - Left: Chat interface with prompt input and code cards
 * - Right top: Output display (charts, tables)
 * - Right bottom: Code display
 */
function App() {
  // API Key management
  const [apiKey, setApiKey] = useState('');
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);

  // Chat state
  const [messages, setMessages] = useState([]);
  const [inputValue, setInputValue] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Code cards state
  const [codeCards, setCodeCards] = useState([]);
  const [selectedCardId, setSelectedCardId] = useState(null);

  // R execution state
  const [currentOutput, setCurrentOutput] = useState(null);
  const [currentCode, setCurrentCode] = useState('');

  // UI state
  const [viewMode, setViewMode] = useState('explore'); // 'explore' or 'report'
  const [dataFrames, setDataFrames] = useState([]);
  const [suggestionsEnabled, setSuggestionsEnabled] = useState(true);
  const [autoFormatTabular, setAutoFormatTabular] = useState(true);
  const [columnMetadata, setColumnMetadata] = useState(null); // Dataset schema for Claude (DEPRECATED: use datasetRegistry)
  const [showConversationsMenu, setShowConversationsMenu] = useState(false);

  // Dataset registry - tracks all datasets in R environment with their metadata
  const [datasetRegistry, setDatasetRegistry] = useState({
    activeDataset: null,  // Currently active dataset name (e.g., 'data', 'life_exp_tidy')
    datasets: {}          // Map of dataset name -> { columnMetadata, lastModified, hash }
  });
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const [favoritedCardIds, setFavoritedCardIds] = useState(new Set());
  const [isSubmitAnimating, setIsSubmitAnimating] = useState(false);
  const [expandedSuggestions, setExpandedSuggestions] = useState(new Set()); // Track which message IDs have expanded suggestions
  const [isRecording, setIsRecording] = useState(false);
  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [showSnowflakeModal, setShowSnowflakeModal] = useState(false);

  // Refs for resizable panels
  const splitInstanceRef = useRef(null);
  const splitVerticalInstanceRef = useRef(null);
  const savedHorizontalSizesRef = useRef([50, 50]);
  const savedVerticalSizesRef = useRef([50, 50]);
  const textareaRef = useRef(null);
  const leftPanelRef = useRef(null);
  const messagesContainerRef = useRef(null);
  const cardRefsRef = useRef({});
  const fileInputRef = useRef(null);
  const recognitionRef = useRef(null);
  const autoSubmitTimerRef = useRef(null);
  const submitButtonRef = useRef(null);
  const shouldAutoSubmitRef = useRef(false);
  const isButtonPressedRef = useRef(false);
  const slashMenuRef = useRef(null);

  // Helper function to determine suggestion icon based on content
  const getSuggestionIcon = (suggestion) => {
    // Handle both string and object suggestions
    const suggestionText = typeof suggestion === 'object' ? suggestion.text : suggestion;
    const lowerSuggestion = suggestionText.toLowerCase();

    // Check for pivot_longer transformations
    if (lowerSuggestion.includes('pivot_longer') || lowerSuggestion.includes('pivot longer')) {
      return 'pivot-longer';
    }

    // Check for plot/chart creation
    if (lowerSuggestion.includes('plot') ||
        lowerSuggestion.includes('chart') ||
        lowerSuggestion.includes('graph') ||
        lowerSuggestion.includes('histogram') ||
        lowerSuggestion.includes('scatter') ||
        lowerSuggestion.includes('boxplot') ||
        lowerSuggestion.includes('barplot') ||
        lowerSuggestion.includes('visualization') ||
        lowerSuggestion.includes('visualize')) {
      return 'chart';
    }

    // Check for tabular data output
    if (lowerSuggestion.includes('show') && (lowerSuggestion.includes('rows') || lowerSuggestion.includes('first'))) {
      return 'table';
    }
    if (lowerSuggestion.includes('display') ||
        lowerSuggestion.includes('view') ||
        lowerSuggestion.includes('print') ||
        (lowerSuggestion.includes('format') && lowerSuggestion.includes('gt'))) {
      return 'table';
    }

    // Default to sparkle for all other suggestions
    return 'sparkle';
  };

  // Load API key from localStorage on mount
  useEffect(() => {
    const storedKey = localStorage.getItem('anthropic_api_key');
    if (storedKey) {
      setApiKey(storedKey);
    } else {
      setShowApiKeyModal(true);
    }

    // Load auto format tabular setting
    const storedAutoFormat = localStorage.getItem('auto_format_tabular');
    if (storedAutoFormat !== null) {
      setAutoFormatTabular(storedAutoFormat === 'true');
    }
  }, []);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }, [inputValue]);

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    if (messagesContainerRef.current) {
      messagesContainerRef.current.scrollTop = messagesContainerRef.current.scrollHeight;
    }
  }, [messages]);

  // Auto-expand latest suggestions and collapse previous ones
  useEffect(() => {
    // Find all messages with suggestions
    const messagesWithSuggestions = messages
      .map((msg, idx) => ({
        ...msg,
        index: idx,
        hasSuggestions: msg.role === 'assistant' && (
          (msg.suggestions && msg.suggestions.length > 0) ||
          (msg.content && msg.content.includes('**Suggestions for further analysis:**'))
        )
      }))
      .filter(msg => msg.hasSuggestions);

    if (messagesWithSuggestions.length > 0) {
      // Get the latest message with suggestions
      const latestWithSuggestions = messagesWithSuggestions[messagesWithSuggestions.length - 1];

      // Expand only the latest, collapse all others
      setExpandedSuggestions(new Set([latestWithSuggestions.id]));
    }
  }, [messages]);

  // Close conversations menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showConversationsMenu && !event.target.closest('.conversations-menu-container')) {
        setShowConversationsMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showConversationsMenu]);

  // Close options menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showOptionsMenu && !event.target.closest('.options-menu-container')) {
        setShowOptionsMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showOptionsMenu]);

  // Close slash menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showSlashMenu && slashMenuRef.current && !slashMenuRef.current.contains(event.target)) {
        setShowSlashMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSlashMenu]);

  // Initialize Split.js for resizable panels
  useEffect(() => {
    // Initialize Split.js for panel resizing
    // Horizontal split (left panel | right column)
    if (!splitInstanceRef.current) {
      splitInstanceRef.current = Split(['#left-panel', '#right-column'], {
        sizes: savedHorizontalSizesRef.current,
        minSize: [300, 300],
        gutterSize: 8,
        cursor: 'col-resize'
      });
    }

    // Vertical split (right top panel | right bottom panel)
    if (!splitVerticalInstanceRef.current) {
      splitVerticalInstanceRef.current = Split(['#right-top-panel', '#right-bottom-panel'], {
        direction: 'vertical',
        sizes: savedVerticalSizesRef.current,
        minSize: [100, 100],
        gutterSize: 8,
        cursor: 'row-resize'
      });
    }

    // Cleanup
    return () => {
      if (splitInstanceRef.current) {
        // Save current sizes before destroying
        savedHorizontalSizesRef.current = splitInstanceRef.current.getSizes();
        splitInstanceRef.current.destroy();
        splitInstanceRef.current = null;
      }
      if (splitVerticalInstanceRef.current) {
        // Save current sizes before destroying
        savedVerticalSizesRef.current = splitVerticalInstanceRef.current.getSizes();
        splitVerticalInstanceRef.current.destroy();
        splitVerticalInstanceRef.current = null;
      }
    };
  }, []);

  // Handle keyboard navigation for code cards
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Only handle if focus is not in textarea and we have code cards
      if (document.activeElement === textareaRef.current || codeCards.length === 0) {
        return;
      }

      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();

        const currentIndex = codeCards.findIndex(card => card.id === selectedCardId);
        let newIndex;

        if (e.key === 'ArrowDown') {
          // Move down (next card)
          newIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, codeCards.length - 1);
        } else {
          // Move up (previous card)
          newIndex = currentIndex === -1 ? codeCards.length - 1 : Math.max(currentIndex - 1, 0);
        }

        const newCard = codeCards[newIndex];
        if (newCard) {
          handleCardSelect(newCard.id);

          // Scroll the selected card into view
          const cardElement = cardRefsRef.current[newCard.id];
          if (cardElement) {
            cardElement.scrollIntoView({
              behavior: 'smooth',
              block: 'nearest',
              inline: 'nearest'
            });
          }
        }
      }
    };

    const leftPanel = leftPanelRef.current;
    if (leftPanel) {
      leftPanel.addEventListener('keydown', handleKeyDown);
    }

    return () => {
      if (leftPanel) {
        leftPanel.removeEventListener('keydown', handleKeyDown);
      }
    };
  }, [codeCards, selectedCardId]);

  // Fetch dataframes when viewMode is 'data' - DISABLED (not using data view)
  // useEffect(() => {
  //   if (viewMode === 'data') {
  //     const fetchDataFrames = async () => {
  //       try {
  //         const response = await fetch('/api/list-dataframes');
  //         if (response.ok) {
  //           const data = await response.json();
  //           setDataFrames(data.dataframes || []);
  //         }
  //       } catch (error) {
  //         console.error('Error fetching dataframes:', error);
  //       }
  //     };
  //     fetchDataFrames();
  //   }
  // }, [viewMode]);

  // Handle API key save
  const handleSaveApiKey = (key) => {
    setApiKey(key);
    localStorage.setItem('anthropic_api_key', key);
    setShowApiKeyModal(false);
  };

  // Handle Quarto report creation
  const handleCreateReport = async () => {
    console.log('=== REPORT GENERATION START ===');

    // Open a blank window immediately to avoid popup blockers
    // This must happen synchronously in the click handler
    const reportWindow = window.open('about:blank', '_blank');
    if (reportWindow) {
      reportWindow.document.write(`<html>
<head>
  <style>
    body {
      font-family: system-ui;
      padding: 40px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
    }
    .spinner {
      width: 34px;
      height: 34px;
      margin-top: 20px;
    }
  </style>
</head>
<body>
  <h2>Generating report...</h2>
  <p>Please wait while your report is being created.</p>
  <img src="/animated-diamond-loop.svg" alt="Loading..." class="spinner" />
</body>
</html>`);
    }

    try {
      const favoritedCards = codeCards.filter(card => favoritedCardIds.has(card.id));
      console.log('Step 1: Favorited cards filtered:', favoritedCards.length);

      // Generate intelligent descriptions using Claude
      let descriptions = [];
      console.log('Step 2: Starting Claude API call for descriptions...');
      try {
        const descriptionsPrompt = `Generate concise narrative descriptions for the following outputs in a report. For each item, provide a 1-2 sentence description that explains what the visualization or table shows and what insights can be drawn from it. Do NOT mention R code, functions, or libraries - only describe what the output shows.

${favoritedCards.map((card, idx) => {
  // Determine if this is a chart/plot or a table
  const hasPlot = card.output?.plots?.some(plot => plot.type !== 'html');
  const hasTable = card.output?.plots?.some(plot => plot.type === 'html') || card.output?.tables?.length > 0;
  const outputType = hasPlot ? 'Chart/Visualization' : (hasTable ? 'Table' : 'Output');

  return `
${outputType} ${idx + 1}:
R Code: ${card.code}
Output summary: ${card.output?.output || 'No text output'}`;
}).join('\n')}

Please respond with a JSON object in this format:
{
  "descriptions": ["description for item 1", "description for item 2", ...]
}`;

        console.log('Sending prompt to Claude API...');
        const claudeResponse = await sendMessageToClaude(apiKey, descriptionsPrompt, [], false, [], null);
        console.log('Claude API response received:', claudeResponse.text.substring(0, 200));

        const jsonMatch = claudeResponse.text.match(/\{[\s\S]*"descriptions"[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          descriptions = parsed.descriptions || [];
          console.log('Successfully parsed descriptions from Claude:', descriptions.length);
        } else {
          console.warn('No JSON match found in Claude response');
        }
      } catch (e) {
        console.error('Claude API call failed:', e);
        console.warn('Could not get descriptions from Claude, using code-based descriptions');
        // Generate basic descriptions from the R code
        descriptions = favoritedCards.map(card => {
          const code = card.code.toLowerCase();
          const hasPlot = card.output?.plots?.some(plot => plot.type !== 'html');
          const hasTable = card.output?.plots?.some(plot => plot.type === 'html') || card.output?.tables?.length > 0;

          if (hasTable && !hasPlot) {
            return 'This table presents key data values and statistics from the dataset in a structured format.';
          } else if (code.includes('ggplot') || code.includes('plot(')) {
            return 'This visualization displays the relationship between variables in the dataset, showing patterns and trends in the data.';
          } else if (code.includes('summary') || code.includes('str(')) {
            return 'This output provides statistical summaries and descriptive information about the dataset.';
          } else {
            return 'This analysis result shows key findings from the data exploration.';
          }
        });
        console.log('Using fallback descriptions:', descriptions.length);
      }

      console.log('Step 3: Generating report data...');
      // Generate report data from conversation and favorited outputs
      const reportData = generateQuartoReport(messages, codeCards, favoritedCardIds, descriptions);
      console.log('Report data generated:', {
        title: reportData.title,
        findingsCount: reportData.findings.length,
        hasFindings: reportData.findings.length > 0
      });

      console.log('Step 4: Sending to backend...');
      // Send to backend to render
      const response = await fetch('/api/create-quarto-report', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(reportData)
      });

      console.log('Backend response status:', response.status);
      if (!response.ok) {
        const errorText = await response.text();
        console.error('Backend error response:', errorText);
        throw new Error(`Failed to create report: ${response.status} ${errorText}`);
      }

      const result = await response.json();
      console.log('Backend result:', result);

      console.log('Step 5: Opening report...');
      // Navigate the pre-opened window to the report URL
      if (result.htmlPath && reportWindow) {
        const reportUrl = `http://localhost:3001/reports/${result.htmlFilename}`;
        console.log('Opening report URL:', reportUrl);
        reportWindow.location.href = reportUrl;
        console.log('=== REPORT GENERATION SUCCESS ===');
      } else if (!reportWindow) {
        console.error('Report window was blocked by popup blocker');
        alert(`Report generated successfully! Please enable popups or open manually:\nhttp://localhost:3001/reports/${result.htmlFilename}`);
      } else {
        console.error('No htmlPath in result');
        if (reportWindow) reportWindow.close();
      }
    } catch (error) {
      console.error('=== REPORT GENERATION FAILED ===');
      console.error('Error details:', error);
      console.error('Error message:', error.message);
      console.error('Error stack:', error.stack);

      // Close the loading window and show error
      if (reportWindow) {
        reportWindow.close();
      }
      alert('Failed to create report: ' + error.message);
    }
  };

  // Generate report data from conversation
  const generateQuartoReport = (messages, codeCards, favoritedCardIds, descriptions = []) => {
    const timestamp = new Date().toLocaleDateString();

    // Generate a meaningful title from the conversation context
    let title = 'Data Analysis Report';
    const userMessages = messages.filter(m => m.role === 'user');
    if (userMessages.length > 0) {
      const firstMsg = userMessages[0].content;
      // Try to extract meaningful dataset name or topic
      if (firstMsg.toLowerCase().includes('load')) {
        const match = firstMsg.match(/load(?:ed)?\s+(\w+)/i);
        if (match) title = `${match[1]} Dataset Analysis`;
      } else if (firstMsg.length < 60) {
        title = firstMsg;
      }
    }

    // Get favorited cards with their outputs
    const favoritedCards = codeCards.filter(card => favoritedCardIds.has(card.id));

    // Debug: log card outputs to console (avoid circular references from DOM elements)
    console.log('Favorited cards for report:', favoritedCards.map(card => ({
      id: card.id,
      hasOutput: !!card.output,
      outputKeys: card.output ? Object.keys(card.output) : [],
      hasTables: !!card.output?.tables,
      tableCount: card.output?.tables?.length || 0,
      hasPlots: !!card.output?.plots,
      plotCount: card.output?.plots?.length || 0
    })));

    // Build findings sections from favorited outputs
    const findings = favoritedCards.map((card, index) => {
      // Separate visual plots from HTML tables
      const plots = [];
      const tables = [];

      if (card.output?.plots) {
        card.output.plots.forEach(plot => {
          if (plot.type === 'html') {
            // HTML widgets are tables (gt tables, formattable, etc.)
            tables.push(plot);
          } else {
            // SVG/image plots
            plots.push(plot);
          }
        });
      }

      // Also include tables from special outputs (like dataset diagnostics)
      if (card.output?.tables) {
        // These are already in the right format
        if (Array.isArray(card.output.tables)) {
          tables.push(...card.output.tables);
        }
      }

      const finding = {
        title: null, // Will be extracted from SVG title tag
        description: descriptions[index] || 'This visualization shows the relationship between the variables in the dataset.',
        code: card.code,
        plots: plots,
        tables: tables,
        textOutput: card.output?.output || ''
      };

      // Debug log each finding
      console.log(`Finding ${index + 1}:`, {
        hasPlots: finding.plots.length > 0,
        plotCount: finding.plots.length,
        hasTables: finding.tables.length > 0,
        tableCount: finding.tables.length,
        tableTypes: finding.tables.map(t => t.type || typeof t),
        hasTextOutput: !!finding.textOutput
      });

      return finding;
    });

    // Generate a brief summary of the analysis
    let summary = 'This paragraph should be a brief summary of the analysis done in the conversation. Describe the dataset and outline the questions asked in the prompts.';

    // Try to generate a more intelligent summary from the conversation
    if (userMessages.length > 0) {
      const datasetMention = userMessages[0].content.match(/\b\w+\.csv\b/i);
      const datasetName = datasetMention ? datasetMention[0].replace('.csv', '') : 'the dataset';
      const numQuestions = userMessages.length;

      summary = `This report presents ${findings.length} key finding${findings.length !== 1 ? 's' : ''} from an analysis of ${datasetName}. `;
      summary += `The analysis addressed ${numQuestions} question${numQuestions !== 1 ? 's' : ''} focused on exploring patterns, relationships, and insights within the data.`;
    }

    return {
      title,
      date: timestamp,
      summary,
      findings,
      hasQuarto: false // Will be detected by backend
    };
  };

  // Handle file selection for load data
  const handleFileSelect = async (event) => {
    const file = event.target.files[0];
    if (file) {
      try {
        let filename = file.name;

        // Check if file already exists in data folder
        const checkResponse = await fetch(`/api/check-file/${encodeURIComponent(filename)}`);
        const checkResult = await checkResponse.json();

        if (!checkResult.exists) {
          // File doesn't exist, upload it
          const formData = new FormData();
          formData.append('file', file);

          const uploadResponse = await fetch('/api/upload-data', {
            method: 'POST',
            body: formData
          });

          if (!uploadResponse.ok) {
            throw new Error('File upload failed');
          }

          const uploadResult = await uploadResponse.json();
          console.log('File uploaded:', uploadResult.filename);
        } else {
          console.log('File already exists in data folder:', filename);
        }

        // Use the new two-phase load-and-report endpoint for accurate reporting
        // Sanitize the filename to get the R variable name (same logic as server)
        let sanitizedVarName = filename.replace(/\.csv$/i, ''); // Remove .csv extension
        sanitizedVarName = sanitizedVarName.replace(/[^a-zA-Z0-9_]/g, '_'); // Replace invalid chars
        sanitizedVarName = sanitizedVarName.replace(/^(\d)/, '_$1'); // Ensure it doesn't start with a number

        const loadMessage = `Loaded ${filename} (dataset variable name: ${sanitizedVarName})`;
        setIsLoading(true);

        // Add user message to chat
        const newUserMessage = {
          id: Date.now(),
          role: 'user',
          content: loadMessage
        };
        setMessages(prev => [...prev, newUserMessage]);

        try {
          // Call the new two-phase load-and-report endpoint
          const response = await fetch('/api/load-and-report-data', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              filename: filename,
              apiKey: apiKey,
              suggestionsEnabled: suggestionsEnabled
            })
          });

          if (!response.ok) {
            throw new Error('Failed to load and analyze data');
          }

          const result = await response.json();

          // Debug: Log the result to see what we got back
          console.log('Load-and-report result:', result);
          console.log('reportSections:', result.reportSections);
          console.log('filename:', result.filename);

          // Store column metadata in dataset registry
          if (result.columnMetadata) {
            const datasetName = result.datasetName || 'data';  // Default to 'data'
            const metadataHash = JSON.stringify({
              ncol: result.columnMetadata.length,
              columns: result.columnMetadata.map(c => c.name)
            });

            // Update dataset registry
            setDatasetRegistry({
              activeDataset: datasetName,
              datasets: {
                [datasetName]: {
                  columnMetadata: result.columnMetadata,
                  lastModified: Date.now(),
                  hash: metadataHash,
                  source: 'csv',
                  filename: filename
                }
              }
            });

            // Also update legacy columnMetadata for backward compatibility
            setColumnMetadata(result.columnMetadata);
            console.log(`Dataset registry updated for '${datasetName}':`, result.columnMetadata);
          }

          // Create a code card for the diagnostic code
          const diagnosticCard = {
            id: `card-${Date.now()}`,
            code: result.code,
            summary: `Dataset Diagnostics: ${filename}`,
            description: 'Comprehensive dataset analysis including structure, missing data, and tidy format assessment',
            output: {
              text: result.output,
              error: result.error
            }
          };

          // Add assistant response with the tabbed report
          const assistantMessage = {
            id: Date.now() + 1,
            role: 'assistant',
            content: '',  // Empty content since we'll use DatasetReport component
            displayContent: '',
            codeCards: [diagnosticCard],
            suggestions: result.suggestions || [],
            reportSections: result.reportSections,
            filename: result.filename
          };
          console.log('Assistant message created:', assistantMessage);
          setMessages(prev => [...prev, assistantMessage]);

          // Add the diagnostic card to global cards array
          setCodeCards(prev => [...prev, diagnosticCard]);

          // Auto-select the diagnostic card
          setSelectedCardId(diagnosticCard.id);
          setCurrentCode(diagnosticCard.code);

          // Set the output (already executed on backend)
          setCurrentOutput({
            text: result.output,
            error: result.error,
            plots: []
          });

        } catch (error) {
          console.error('Error loading and reporting data:', error);
          const errorMessage = {
            id: Date.now() + 1,
            role: 'assistant',
            content: `Error: ${error.message}. Please check your API key and try again.`
          };
          setMessages(prev => [...prev, errorMessage]);
        } finally {
          setIsLoading(false);
        }
      } catch (error) {
        console.error('Error uploading file:', error);
        alert('Failed to upload file. Please try again.');
      }

      // Reset the file input so the same file can be selected again
      event.target.value = '';
    }
  };

  // Handle load data button click
  const handleLoadData = () => {
    if (fileInputRef.current) {
      fileInputRef.current.click();
    }
  };

  // Handle Snowflake browser modal
  const handleOpenSnowflake = () => {
    setShowSnowflakeModal(true);
  };

  const handleLoadSnowflakeTables = async (selectedItems) => {
    setIsLoading(true);

    for (const item of selectedItems) {
      const varName = item.name.toLowerCase().replace(/[^a-z0-9_]/g, '_');
      const fullTableName = `${item.database}.${item.schema}.${item.name}`;
      const loadMessage = `Loaded ${fullTableName} (dataset variable name: ${varName})`;

      // Add user message to chat
      const newUserMessage = {
        id: Date.now(),
        role: 'user',
        content: loadMessage
      };
      setMessages(prev => [...prev, newUserMessage]);

      try {
        // Call the new load-and-report-snowflake endpoint
        const response = await fetch('/api/load-and-report-snowflake', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            database: item.database,
            schema: item.schema,
            tableName: item.name,
            varName: varName,
            apiKey: apiKey,
            suggestionsEnabled: suggestionsEnabled
          })
        });

        if (!response.ok) {
          throw new Error('Failed to load and analyze Snowflake table');
        }

        const result = await response.json();

        console.log('Snowflake load result:', result);

        // Store column metadata in dataset registry
        if (result.columnMetadata) {
          const datasetName = result.datasetName || varName;  // Use specified varName or default
          const metadataHash = JSON.stringify({
            ncol: result.columnMetadata.length,
            columns: result.columnMetadata.map(c => c.name)
          });

          // Update dataset registry
          setDatasetRegistry({
            activeDataset: datasetName,
            datasets: {
              [datasetName]: {
                columnMetadata: result.columnMetadata,
                lastModified: Date.now(),
                hash: metadataHash,
                source: 'snowflake',
                fullTableName: fullTableName
              }
            }
          });

          // Also update legacy columnMetadata for backward compatibility
          setColumnMetadata(result.columnMetadata);
          console.log(`Dataset registry updated for '${datasetName}':`, result.columnMetadata);
        }

        // Validate we have report sections
        if (!result.reportSections || Object.keys(result.reportSections).length === 0) {
          throw new Error('No analysis report was generated. The server may have failed to analyze the table.');
        }

        // Create a code card for the diagnostic code
        const diagnosticCard = {
          id: `card-${Date.now()}`,
          code: result.code,
          summary: `Dataset Diagnostics: ${fullTableName}`,
          description: 'Comprehensive dataset analysis including structure, missing data, and tidy format assessment',
          output: {
            text: result.output,
            error: result.error
          }
        };

        // Add assistant response with the tabbed report
        const assistantMessage = {
          id: Date.now() + 1,
          role: 'assistant',
          content: '',  // Empty content since we'll use DatasetReport component
          displayContent: '',
          codeCards: [diagnosticCard],
          suggestions: result.suggestions || [],
          reportSections: result.reportSections,
          filename: fullTableName
        };
        console.log('Creating assistant message with reportSections:', assistantMessage.reportSections);
        console.log('[SNOWFLAKE LOAD] Suggestions received from server:', result.suggestions);
        console.log('[SNOWFLAKE LOAD] Suggestion count:', result.suggestions?.length);
        console.log('[SNOWFLAKE LOAD] First suggestion type:', result.suggestions?.length > 0 ? typeof result.suggestions[0] : 'none');
        console.log('[SNOWFLAKE LOAD] First suggestion value:', result.suggestions?.[0]);
        setMessages(prev => [...prev, assistantMessage]);

        // Add the diagnostic card to global cards array
        setCodeCards(prev => [...prev, diagnosticCard]);

        // Wait a bit before processing next item
        if (selectedItems.indexOf(item) < selectedItems.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 500));
        }

      } catch (error) {
        console.error('Error loading Snowflake table:', error);
        const errorMessage = {
          id: Date.now() + 2,
          role: 'assistant',
          content: `Error loading ${fullTableName}: ${error.message}`
        };
        setMessages(prev => [...prev, errorMessage]);
      }
    }

    setIsLoading(false);
  };

  // Handle new conversation - reset all panels
  const handleNewConversation = async () => {
    setMessages([]);
    setCodeCards([]);
    setSelectedCardId(null);
    setCurrentOutput(null);
    setCurrentCode('');
    setInputValue('');

    // Clear R workspace
    try {
      await fetch('/api/clear-workspace', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        }
      });
      console.log('R workspace cleared');
    } catch (error) {
      console.error('Error clearing workspace:', error);
    }
  };

  // Toggle conversations menu
  const handleToggleConversations = () => {
    setShowConversationsMenu(!showConversationsMenu);
  };

  // Handle suggestion click - populate input field but don't submit
  const handleSuggestionClick = (suggestion, event) => {
    // SAFETY: Ensure suggestion is always a plain string, never an object or DOM element
    // Interactive suggestions pass suggestion.text objects, while plain suggestions pass strings
    const suggestionText = typeof suggestion === 'string' ? suggestion : String(suggestion?.text || suggestion || '');

    // Remove focus from the button to prevent blue outline
    if (event?.currentTarget) {
      event.currentTarget.blur();
    }

    if (event?.shiftKey) {
      // Shift-click: submit directly
      handleSendMessage(suggestionText);
    } else {
      // Normal click: populate input
      setInputValue(suggestionText);
      // Focus the textarea
      if (textareaRef.current) {
        textareaRef.current.focus();
      }
    }
  };

  // Toggle suggestions expansion for a specific message
  const toggleSuggestionsExpansion = (messageId) => {
    setExpandedSuggestions(prev => {
      const newSet = new Set(prev);
      if (newSet.has(messageId)) {
        newSet.delete(messageId);
      } else {
        newSet.add(messageId);
      }
      return newSet;
    });
  };

  // Handle input change - detect slash commands
  const handleInputChange = (e) => {
    const value = e.target.value;
    setInputValue(value);

    // Show slash menu when input starts with "/"
    if (value === '/') {
      setShowSlashMenu(true);
    } else {
      setShowSlashMenu(false);
    }
  };

  // Handle slash command: show loaded datasets
  const handleShowLoadedDatasets = () => {
    setShowSlashMenu(false);
    setInputValue('');

    // TODO: Get list of loaded datasets from R workspace
    // For now, show a placeholder message
    const message = {
      id: Date.now(),
      role: 'assistant',
      content: 'Loaded datasets: (feature coming soon)'
    };
    setMessages(prev => [...prev, message]);
  };

  // Handle slash command: open dataset
  const handleOpenDataset = () => {
    setShowSlashMenu(false);
    setInputValue('');
    handleLoadData();
  };

  // Initialize speech recognition
  useEffect(() => {
    if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      const recognition = new SpeechRecognition();

      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.lang = 'en-US';

      recognition.onresult = (event) => {
        // Get all final results
        let transcript = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          if (event.results[i].isFinal) {
            transcript += event.results[i][0].transcript + ' ';
          }
        }

        // Append to input
        if (transcript) {
          setInputValue(prev => prev + transcript);
        }
      };

      recognition.onerror = (event) => {
        console.error('Speech recognition error:', event.error);
        if (event.error !== 'no-speech') {
          setIsRecording(false);
          isButtonPressedRef.current = false;
          shouldAutoSubmitRef.current = false;
        }
      };

      recognition.onend = () => {
        // If button is still pressed, restart recognition
        if (isButtonPressedRef.current) {
          try {
            recognition.start();
          } catch (error) {
            console.error('Error restarting recognition:', error);
          }
        } else {
          setIsRecording(false);

          // Auto-submit if user released the button (not an error)
          if (shouldAutoSubmitRef.current) {
            shouldAutoSubmitRef.current = false;
            // Small delay to ensure state updates
            setTimeout(() => {
              if (submitButtonRef.current && !submitButtonRef.current.disabled) {
                submitButtonRef.current.click();
              }
            }, 100);
          }
        }
      };

      recognitionRef.current = recognition;
    }
  }, []);

  // Handle voice input press (start recording)
  const handleVoicePress = () => {
    if (!recognitionRef.current) {
      alert('Speech recognition is not supported in your browser. Please use Chrome, Edge, or Safari.');
      return;
    }

    if (isLoading) return;

    isButtonPressedRef.current = true;
    shouldAutoSubmitRef.current = false;

    try {
      recognitionRef.current.start();
      setIsRecording(true);
    } catch (error) {
      console.error('Error starting recognition:', error);
      setIsRecording(false);
      isButtonPressedRef.current = false;
    }
  };

  // Handle voice input release (stop recording and submit)
  const handleVoiceRelease = () => {
    isButtonPressedRef.current = false;

    if (recognitionRef.current && isRecording) {
      shouldAutoSubmitRef.current = true;
      recognitionRef.current.stop();
    }
  };

  // Toggle options menu
  const handleToggleOptions = () => {
    setShowOptionsMenu(!showOptionsMenu);
  };

  // Handle sending a message to Claude
  const handleSendMessage = async (messageOverride = null) => {
    // SAFETY: Ensure message is always a string, never an object or DOM element
    const rawMessage = messageOverride || inputValue;
    const messageToSend = (typeof rawMessage === 'string' ? rawMessage : String(rawMessage || '')).trim();
    if (!messageToSend || isLoading) return;

    // Clear any pending auto-submit timer
    if (autoSubmitTimerRef.current) {
      clearTimeout(autoSubmitTimerRef.current);
      autoSubmitTimerRef.current = null;
    }

    // Trigger submit button animation (will reset when response received)
    setIsSubmitAnimating(true);

    const userMessage = messageToSend;
    setInputValue('');
    setIsLoading(true);

    // Add user message to chat
    const newUserMessage = {
      id: Date.now(),
      role: 'user',
      content: userMessage
    };
    setMessages(prev => [...prev, newUserMessage]);

    try {
      // Collect recent plot images from code cards (last 3 plots for context)
      // SAFETY: Create clean objects to avoid circular references or DOM elements
      const recentPlots = [];
      for (const card of codeCards.slice(-3)) {
        if (card.output && card.output.plots) {
          for (const plot of card.output.plots) {
            if (plot.pngBase64) {
              recentPlots.push({
                base64Data: String(plot.pngBase64),
                summary: String(card.summary || '')
              });
            }
          }
        }
      }

      // Get active dataset metadata from registry
      const activeDatasetMetadata = datasetRegistry.activeDataset && datasetRegistry.datasets[datasetRegistry.activeDataset]
        ? datasetRegistry.datasets[datasetRegistry.activeDataset].columnMetadata
        : columnMetadata;  // Fall back to legacy metadata

      // Ensure columnMetadata is serializable (no DOM elements or circular refs)
      // Create a clean copy with only the fields we need
      const cleanColumnMetadata = activeDatasetMetadata ? activeDatasetMetadata.map(col => ({
        name: col.name,
        type: col.type,
        ...(col.values && { values: Array.isArray(col.values) ? col.values : [] }),
        ...(col.min !== undefined && { min: col.min }),
        ...(col.max !== undefined && { max: col.max })
      })) : null;

      // Send to Claude API with plot images and column metadata
      const response = await sendMessageToClaude(
        apiKey,
        userMessage,
        messages.map(m => ({ role: m.role, content: m.content })),
        suggestionsEnabled,
        recentPlots,  // Pass recent plots for Claude to see
        cleanColumnMetadata,  // Pass dataset schema so Claude knows column names
        datasetRegistry.activeDataset  // Pass active dataset name
      );

      // Create code cards for any R code blocks
      const newCards = response.rCodeBlocks.length > 0
        ? response.rCodeBlocks.map((block, index) => ({
            id: `card-${Date.now()}-${index}`,
            code: block.code,
            summary: block.summary,
            description: block.description,
            output: null
          }))
        : [];

      // Strip R code blocks from the displayed message text
      // Matches both ```r and ```R with optional whitespace and content
      let displayText = response.text.replace(/```[rR]\s*[\s\S]*?```/g, '').trim();

      // Strip reactive component JSON blocks from displayed text
      // These will be rendered as interactive components instead
      if (response.reactiveComponents && response.reactiveComponents.length > 0) {
        displayText = displayText.replace(/```json\s*[\s\S]*?```/g, '').trim();
      }

      // If we have structured suggestions, also strip the textual suggestions section
      if (response.suggestions && response.suggestions.length > 0) {
        // Strip "Suggestions for further analysis:" section and everything after it
        displayText = displayText.replace(/\*\*Suggestions for further analysis:\*\*[\s\S]*$/g, '').trim();
      }

      // Debug: Log if suggestions are enabled and what the message contains
      console.log('Suggestions enabled:', suggestionsEnabled);
      console.log('Message text after stripping code:', displayText);
      console.log('Reactive components found:', response.reactiveComponents?.length || 0);

      // Add assistant response to chat with embedded code cards and reactive components
      // Store both original text (for API) and display text (for rendering)
      const assistantMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: response.text,  // Keep original for API
        displayContent: displayText,  // Stripped version for display
        codeCards: newCards,  // Attach code cards to this message
        suggestions: response.suggestions || undefined,  // Add suggestions if available
        reactiveComponents: response.reactiveComponents || undefined  // Add reactive components if available
      };

      console.log('[handleSendMessage] Assistant message with suggestions:', assistantMessage.suggestions);
      console.log('[handleSendMessage] Assistant message with reactive components:', assistantMessage.reactiveComponents);
      setMessages(prev => [...prev, assistantMessage]);

      // Add cards to global cards array
      if (newCards.length > 0) {
        setCodeCards(prev => [...prev, ...newCards]);

        // Auto-select the first new card
        const firstNewCard = newCards[0];
        setSelectedCardId(firstNewCard.id);
        setCurrentCode(firstNewCard.code);

        // Execute the R code
        executeSelectedCode(firstNewCard.code, firstNewCard.id);
      }
    } catch (error) {
      console.error('Error sending message:', error);
      const errorMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: `Error: ${error.message}. Please check your API key and try again.`
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsLoading(false);
      setIsSubmitAnimating(false);
    }
  };

  // Handle code card selection
  const handleCardSelect = (cardId) => {
    setSelectedCardId(cardId);
    const card = codeCards.find(c => c.id === cardId);
    if (card) {
      setCurrentCode(card.code);

      // If we already have output for this card, display it
      if (card.output) {
        setCurrentOutput(card.output);
      } else {
        // Execute the code
        executeSelectedCode(card.code, cardId);
      }
    }
  };

  // Toggle favorite status for currently selected card
  const handleToggleFavorite = () => {
    if (selectedCardId) {
      setFavoritedCardIds(prev => {
        const newSet = new Set(prev);
        if (newSet.has(selectedCardId)) {
          newSet.delete(selectedCardId);
        } else {
          newSet.add(selectedCardId);
        }
        return newSet;
      });
    }
  };

  // Execute R code and update output
  const executeSelectedCode = async (code, cardId) => {
    try {
      // Determine if this code might modify the dataset structure
      const mightModifyDataset = code.includes('pivot_longer') ||
                                  code.includes('pivot_wider') ||
                                  code.includes('mutate') ||
                                  code.includes('filter') ||
                                  code.includes('select') ||
                                  code.includes('join') ||
                                  code.includes('<-') ||  // Assignment
                                  code.includes('=');     // Assignment

      // Execute the code via backend, requesting metadata refresh if needed
      const result = await executeRCode(
        code,
        autoFormatTabular,
        mightModifyDataset,  // refreshMetadata
        datasetRegistry.activeDataset || 'data'  // activeDataset
      );

      setCurrentOutput(result);

      // Update dataset registry if metadata was refreshed
      if (result.updatedMetadata) {
        const { datasetName, columnMetadata, hash, shouldBecomeActive } = result.updatedMetadata;
        console.log(`[EXECUTE] Updating registry for dataset '${datasetName}' with refreshed metadata`);

        if (shouldBecomeActive) {
          console.log(`[EXECUTE] Auto-switching active dataset to '${datasetName}' (tidy dataset)`);
        }

        setDatasetRegistry(prev => ({
          ...prev,
          // Only update active dataset if shouldBecomeActive is true, otherwise keep current
          activeDataset: shouldBecomeActive ? datasetName : prev.activeDataset,
          datasets: {
            ...prev.datasets,
            [datasetName]: {
              columnMetadata: columnMetadata,
              lastModified: Date.now(),
              hash: hash
            }
          }
        }));

        // Also update legacy columnMetadata for backward compatibility
        // Only if this became the active dataset
        if (shouldBecomeActive) {
          setColumnMetadata(columnMetadata);
        }
      }

      // Store output with the card using the provided cardId
      setCodeCards(prev =>
        prev.map(card =>
          card.id === cardId
            ? { ...card, output: result }
            : card
        )
      );
    } catch (error) {
      console.error('Error executing R code:', error);
      setCurrentOutput({
        output: '',
        plots: [],
        tables: [],
        error: error.message
      });
    }
  };

  // Handle Enter key in input
  const handleKeyPress = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  // Parse suggestions from message content
  const parseSuggestions = (content) => {
    // Safety check: ensure content is a string
    if (typeof content !== 'string') {
      console.error('[parseSuggestions] ERROR: content is not a string!', typeof content, content);
      return { mainContent: String(content || ''), suggestions: [] };
    }

    const suggestionsMatch = content.match(/\*\*Suggestions for further analysis:\*\*\s*([\s\S]*?)(?:\n\n|$)/);
    if (!suggestionsMatch) {
      console.log('[parseSuggestions] No suggestions found in content');
      return { mainContent: content, suggestions: [] };
    }

    const mainContent = content.replace(/\*\*Suggestions for further analysis:\*\*\s*[\s\S]*$/, '').trim();
    const suggestionsText = suggestionsMatch[1];
    const suggestions = suggestionsText
      .split('\n')
      .filter(line => line.trim().startsWith('-'))
      .map(line => line.replace(/^-\s*/, '').trim())
      .filter(s => s.length > 0);

    console.log('[parseSuggestions] Found', suggestions.length, 'suggestions:', suggestions);
    return { mainContent, suggestions };
  };

  // Render chat messages
  const renderMessage = (message) => {
    // Use displayContent for assistant messages if available, otherwise use content
    const contentToDisplay = message.role === 'assistant' && message.displayContent
      ? message.displayContent
      : message.content;

    // Check if suggestions are provided directly in message object (from new load-and-report endpoint)
    // Otherwise parse them from the content
    const { mainContent, suggestions } = message.role === 'assistant'
      ? (message.suggestions
          ? (() => {
              console.log('[renderMessage] Using suggestions from message object:', message.suggestions);
              return { mainContent: contentToDisplay, suggestions: message.suggestions };
            })()
          : parseSuggestions(contentToDisplay))
      : { mainContent: contentToDisplay, suggestions: [] };

    if (suggestions.length > 0) {
      console.log('[renderMessage] Rendering', suggestions.length, 'suggestions. First suggestion type:', typeof suggestions[0]);
    }

    // Debug logging for content type
    if (typeof mainContent !== 'string' && mainContent !== undefined) {
      console.error('[renderMessage] WARNING: mainContent is not a string!', typeof mainContent);
    }

    // For assistant messages, use negative margin to pull closer to previous message
    // User measured 33px and wants 20px, so reduce by 13px
    // Exception: Dataset reports don't use negative margin (they have their own spacing)
    const hasDatasetReport = message.reportSections && message.filename;

    // User messages get extra top margin (doubled from 12px to 24px)
    const containerStyle = message.role === 'assistant' && !hasDatasetReport
      ? { marginTop: '-13px' }
      : message.role === 'user'
        ? { marginTop: '24px' }
        : {};

    return (
      <div key={message.id} className="mb-4" style={containerStyle}>
        {/* Message bubble - only show if there's content */}
        {mainContent && (
          <div className={message.role === 'user' ? 'text-right' : 'text-left'}>
            <div
              className={`inline-block max-w-[80%] p-3 rounded-lg ${
                message.role === 'user'
                  ? 'bg-[#add7fd] text-gray-800'
                  : 'bg-white text-gray-800'
              }`}
              style={{ fontSize: '11pt' }}
            >
              <div className="whitespace-pre-wrap break-words text-left">
                <ReactMarkdown>{typeof mainContent === 'string' ? mainContent : String(mainContent || '')}</ReactMarkdown>
              </div>
            </div>
          </div>
        )}

        {/* Dataset report with tabs (if available) */}
        {message.reportSections && message.filename && (
          <div className="max-w-[80%]" style={{ marginTop: '7px' }}>
            <DatasetReport
              filename={message.filename}
              reportSections={message.reportSections}
            />
          </div>
        )}

        {/* Code cards inline (if any) */}
        {message.codeCards && message.codeCards.length > 0 && (
          <div className="space-y-2 max-w-[80%] mt-1">
            {message.codeCards.map(card => (
              <CodeCard
                key={card.id}
                ref={el => cardRefsRef.current[card.id] = el}
                id={card.id}
                summary={card.summary}
                description={card.description}
                code={card.code}
                isSelected={card.id === selectedCardId}
                onClick={handleCardSelect}
              />
            ))}
          </div>
        )}

        {/* Reactive components (if any) */}
        {message.reactiveComponents && message.reactiveComponents.length > 0 && (
          <div className="space-y-4 max-w-[80%] mt-3">
            {message.reactiveComponents.map((spec, index) => (
              <ReactiveComponent
                key={index}
                spec={spec}
                onError={(error) => {
                  console.error('Reactive component error:', error);
                }}
              />
            ))}
          </div>
        )}

        {/* Suggestions (if any) */}
        {suggestions.length > 0 && (
          <div className="mb-6 ml-0 max-w-2xl mt-1" style={{ fontSize: '10pt' }}>
            <div
              className="flex items-center gap-2 mb-2 cursor-pointer hover:bg-gray-50 rounded px-2 py-1 -mx-2"
              onClick={() => toggleSuggestionsExpansion(message.id)}
            >
              <p className="font-semibold text-gray-700">Suggestions:</p>
              <p className="text-xs text-gray-500 italic">SHIFT click to submit directly</p>
              <img
                src={expandedSuggestions.has(message.id) ? '/carat_open.png' : '/carat_closed.png'}
                alt={expandedSuggestions.has(message.id) ? 'Collapse' : 'Expand'}
                className="w-4 h-4 transition-opacity duration-200"
              />
            </div>
            {expandedSuggestions.has(message.id) && (
              <div className="grid grid-cols-2 gap-3">
                {suggestions.map((suggestion, index) => {
                  const iconName = getSuggestionIcon(suggestion);
                  return (
                    <InteractiveSuggestion
                      key={index}
                      suggestion={suggestion}
                      iconName={iconName}
                      onSubmit={handleSuggestionClick}
                    />
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Render output panel content
  const renderOutput = () => {
    if (!currentOutput) {
      return (
        <div className="flex items-center justify-center h-full text-gray-500">
          <div className="text-center">
            <p>No output yet</p>
            <p className="text-sm mt-2">Select a code card to view its output</p>
          </div>
        </div>
      );
    }

    const isFavorited = selectedCardId && favoritedCardIds.has(selectedCardId);
    const hasPlots = currentOutput.plots && currentOutput.plots.length > 0;

    return (
      <div className="absolute inset-0 overflow-hidden p-1">
        {/* Favorite border overlay */}
        <div className={`absolute inset-1 border-4 rounded-lg pointer-events-none transition-all duration-500 ${isFavorited ? 'border-[#72ccb6]' : 'border-transparent'}`} style={{ zIndex: 10 }}></div>

        {/* Error display - absolutely positioned at top */}
        {currentOutput.error && (
          <div className="absolute top-2 left-2 right-2 bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded z-20">
            <strong>Error:</strong> {currentOutput.error}
          </div>
        )}

        {/* Plots - fill entire space with absolute positioning */}
        {hasPlots && (
          <div className="absolute inset-1">
            {currentOutput.plots.map((plot, index) => {
              // Handle HTML widgets differently from SVG plots
              if (plot.type === 'html') {
                return (
                  <iframe
                    key={index}
                    src={plot.url ? `http://localhost:3001${plot.url}` : undefined}
                    srcDoc={plot.url ? undefined : plot.data}
                    style={{ width: '100%', height: '100%', border: 'none' }}
                    title="HTML Widget Output"
                  />
                );
              } else {
                // SVG plot
                return (
                  <div
                    key={index}
                    className="plot-container"
                    style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    dangerouslySetInnerHTML={{ __html: plot.data }}
                  />
                );
              }
            })}
          </div>
        )}

        {/* Other content - wrapped with padding when no plots */}
        {!hasPlots && (
          <div className="h-full p-4 overflow-auto">
            {/* Text output */}
            {currentOutput.output && (
              <pre className="bg-gray-50 p-4 rounded mb-4 overflow-x-auto" style={{ fontSize: '11pt' }}>
                {currentOutput.output}
              </pre>
            )}

            {/* Tables */}
            {currentOutput.tables && currentOutput.tables.length > 0 && (
              <div className="space-y-4" style={{ fontSize: '11pt' }}>
                {currentOutput.tables.map((table, index) => (
                  <div key={index} className="overflow-x-auto">
                    <table className="min-w-full border border-gray-300">
                      <thead className="bg-gray-100">
                        <tr>
                          {table.headers.map((header, i) => (
                            <th
                              key={i}
                              className="border border-gray-300 px-4 py-2 text-left font-semibold"
                            >
                              {header}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {table.rows.map((row, i) => (
                          <tr key={i} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50'}>
                            {row.map((cell, j) => (
                              <td
                                key={j}
                                className="border border-gray-300 px-4 py-2"
                              >
                                {cell}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <header className="bg-[#edeff0] h-[26px] relative">
        <div className="flex items-center justify-between h-full px-3">
          {/* Mode selector control */}
          <div className="absolute left-1/2 transform -translate-x-1/2 flex items-center h-full">
            <div
              className="relative inline-flex items-center rounded-full"
              style={{
                width: '160px',
                height: '21px',
                backgroundColor: '#dcdce2'
              }}
            >
              {/* Animated selector pill */}
              <div
                className="absolute rounded-full transition-all duration-300 ease-in-out"
                style={{
                  width: '77px',
                  height: '19px',
                  backgroundColor: 'white',
                  boxShadow: '0px 1px 3px rgba(0, 0, 0, 0.1)',
                  left: viewMode === 'explore' ? '1px' : '82px',
                  top: '1px'
                }}
              />
              {/* Explore button */}
              <button
                onClick={() => setViewMode('explore')}
                className={`relative z-10 flex-1 text-sm font-medium transition-colors duration-200 ${
                  viewMode === 'explore'
                    ? 'text-gray-900'
                    : 'text-gray-600'
                }`}
                style={{ fontSize: '11px' }}
              >
                Explore
              </button>
              {/* Report button */}
              <button
                onClick={() => setViewMode('report')}
                className={`relative z-10 flex-1 text-sm font-medium transition-colors duration-200 ${
                  viewMode === 'report'
                    ? 'text-gray-900'
                    : 'text-gray-600'
                }`}
                style={{ fontSize: '11px' }}
              >
                Report
              </button>
            </div>
          </div>

          <div className="flex items-center gap-2 h-full relative">
            <img
              src="/csv-icon.png"
              alt="Load data"
              className="h-4 cursor-pointer"
              onClick={handleLoadData}
              title="Load data from file"
            />
            <img
              src="/snowflake-bug-color-rgb.svg"
              alt="Browse Snowflake"
              className="h-4 cursor-pointer"
              onClick={handleOpenSnowflake}
              title="Browse Snowflake databases"
            />
            <img src="/separator.png" alt="" className="h-4" />
            <img
              src="/new-conversation.png"
              alt="New conversation"
              className="h-4 cursor-pointer"
              onClick={handleNewConversation}
              title="Start new conversation"
            />
            <div className="relative conversations-menu-container">
              <img
                src="/conversations.png"
                alt="Conversations"
                className="h-4 cursor-pointer"
                onClick={handleToggleConversations}
                title="View conversations"
              />
              {showConversationsMenu && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg p-4 min-w-[200px] z-50">
                  <p className="text-sm text-gray-700">Conversations will appear here</p>
                  <p className="text-xs text-gray-500 mt-2">Coming soon...</p>
                </div>
              )}
            </div>
            <img src="/separator.png" alt="" className="h-4" />
            <img
              src={suggestionsEnabled ? "/suggestions-on.png" : "/suggestions-off.png"}
              alt={suggestionsEnabled ? "Suggestions on" : "Suggestions off"}
              className="h-4 cursor-pointer"
              onClick={() => setSuggestionsEnabled(!suggestionsEnabled)}
              title={suggestionsEnabled ? "Suggestions enabled (click to disable)" : "Suggestions disabled (click to enable)"}
            />
            <div className="relative options-menu-container">
              <img
                src="/options.png"
                alt="Options"
                className="h-4 cursor-pointer"
                onClick={handleToggleOptions}
                title="Options menu"
              />
              {showOptionsMenu && (
                <div className="absolute top-full left-0 mt-1 bg-white border border-gray-300 rounded-lg shadow-lg min-w-[220px] z-50 py-1">
                  <button
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
                    onClick={() => {
                      setShowOptionsMenu(false);
                      // TODO: Implement export conversation
                    }}
                  >
                    Export Conversation...
                  </button>
                  <button
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
                    onClick={() => {
                      setShowOptionsMenu(false);
                      // TODO: Implement import conversation
                    }}
                  >
                    Import Conversation...
                  </button>
                  <div className="border-t border-gray-300 my-1"></div>
                  <button
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
                    onClick={() => {
                      setShowOptionsMenu(false);
                      // TODO: Implement Posit AI
                    }}
                  >
                    Posit AI...
                  </button>
                  <div className="border-t border-gray-300 my-1"></div>
                  <button
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors flex items-center justify-between"
                    onClick={() => {
                      const newValue = !autoFormatTabular;
                      setAutoFormatTabular(newValue);
                      localStorage.setItem('auto_format_tabular', newValue.toString());
                    }}
                  >
                    <span>Auto Format Tabular Data</span>
                    <span className="ml-2">{autoFormatTabular ? '✓' : ''}</span>
                  </button>
                  <div className="border-t border-gray-300 my-1"></div>
                  <button
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
                    onClick={() => {
                      setShowOptionsMenu(false);
                      // TODO: Implement Positronic Settings
                    }}
                  >
                    Positronic Settings...
                  </button>
                </div>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* Output panel toolbar icons */}
            <button
              onClick={handleCreateReport}
              className="flex items-center gap-1 hover:bg-gray-200 rounded transition-colors px-1"
              disabled={messages.length === 0}
              title="Create new report from conversation"
            >
              <img src="/report.png" alt="New Report" className="h-4" />
              <span className="text-[12px] font-medium text-gray-700">New Report</span>
            </button>
            <img src="/separator.png" alt="" className="h-4" />
            <button
              onClick={handleToggleFavorite}
              className="w-6 h-6 flex items-center justify-center hover:bg-gray-200 rounded transition-colors"
              disabled={!selectedCardId}
              title={selectedCardId && favoritedCardIds.has(selectedCardId) ? "Remove from favorites" : "Add to favorites"}
            >
              <img
                src={selectedCardId && favoritedCardIds.has(selectedCardId) ? "/favorite-on.png" : "/favorite-off.png"}
                alt="Favorite"
                className="w-4 h-4"
              />
            </button>
            <button
              className="w-6 h-6 flex items-center justify-center hover:bg-gray-200 rounded transition-colors"
              disabled={!selectedCardId}
              title="Copy plot to clipboard"
            >
              <img src="/copy-plot.png" alt="Copy plot" className="w-4 h-4" />
            </button>
            <button
              className="w-6 h-6 flex items-center justify-center hover:bg-gray-200 rounded transition-colors"
              disabled={!selectedCardId}
              title="Check code for errors"
            >
              <img src="/check-code.png" alt="Check code" className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowApiKeyModal(true)}
              className="px-2 py-0.5 bg-[#edeff0] hover:bg-[#d7dadc] text-[#3a7aaf] border border-[#d7dadc] rounded transition-all text-[10px] font-medium ml-2"
              title="Update Anthropic API key"
            >
              Update API Key
            </button>
          </div>
        </div>
      </header>

      {/* Main content area */}
      <div key="explore-mode" className="flex-1 flex overflow-hidden">
          {/* Left Panel - Interaction Panel */}
          <div id="left-panel" ref={leftPanelRef} tabIndex={0} className="flex flex-col bg-white focus:outline-none rounded-[10px]">
          {/* Messages area */}
          <div ref={messagesContainerRef} className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center max-w-2xl px-16">
                  <img
                    key={messages.length}
                    src={`/animated-diamond-logo2.svg?t=${Date.now()}`}
                    alt="Positronic"
                    className="w-[160px] h-[160px] mx-auto mb-[-40px]"
                  />
                  <h2 className="text-2xl font-semibold mb-2 text-[#5d5d66]">Positronic</h2>
                  <p className="text-sm mb-6">
                    Start a conversation with Positronic to analyze data, create visualizations,
                    and generate insights using R code.
                  </p>

                  {/* Data loading options */}
                  <div className="mt-8">
                    <p className="text-sm mb-4 text-gray-500">Get started by loading some data</p>

                    <div className="flex flex-row justify-center items-center gap-8">
                      {/* Snowflake Data */}
                      <button
                        onClick={() => setShowSnowflakeModal(true)}
                        className="data-source-button flex flex-col items-center gap-2 cursor-pointer transition-all"
                      >
                        <img
                          src="/snowflake-bug-color-rgb.svg"
                          alt="Snowflake"
                          className="transition-transform duration-200"
                          style={{ width: '34px', height: '34px' }}
                        />
                        <span className="text-sm text-gray-500">Snowflake Data</span>
                      </button>

                      {/* Local Data */}
                      <button
                        onClick={handleOpenDataset}
                        className="data-source-button flex flex-col items-center gap-2 cursor-pointer transition-all"
                      >
                        <img
                          src="/local-files.svg"
                          alt="Local Files"
                          className="transition-transform duration-200"
                          style={{ width: '34px', height: '34px' }}
                        />
                        <span className="text-sm text-gray-500">Local Data</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {messages.map(renderMessage)}

            {isLoading && (
              <div className="flex items-center gap-2 text-gray-500 mb-4">
                <img src="/animated-diamond-loop.svg" alt="" className="w-[34px] h-[34px]" />
                <span>Positronic is thinking...</span>
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="p-4 bg-white">
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={handleInputChange}
                onKeyPress={handleKeyPress}
                placeholder="Ask Positronic... Type / to see commands"
                className="w-full pl-11 pr-12 py-2 border border-[#616161] rounded-lg focus:outline-none resize-none bg-white overflow-hidden"
                style={{ fontSize: '11pt', minHeight: 'calc(2.5rem + 1px)' }}
                rows="1"
                disabled={isLoading}
              />

              {/* Slash command menu */}
              {showSlashMenu && (
                <div
                  ref={slashMenuRef}
                  className="absolute bottom-full left-0 mb-2 bg-white border border-gray-300 rounded-lg shadow-lg min-w-[250px] z-50 py-1"
                >
                  <button
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
                    onClick={handleShowLoadedDatasets}
                  >
                    /loaded datasets
                  </button>
                  <button
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 transition-colors"
                    onClick={handleOpenDataset}
                  >
                    /open dataset...
                  </button>
                </div>
              )}
              <button
                onMouseDown={handleVoicePress}
                onMouseUp={handleVoiceRelease}
                onMouseLeave={handleVoiceRelease}
                onTouchStart={handleVoicePress}
                onTouchEnd={handleVoiceRelease}
                disabled={isLoading}
                className={`absolute left-1 top-1 w-8 h-8 rounded-md text-white transition-colors flex items-center justify-center ${
                  isRecording
                    ? 'bg-red-500 hover:bg-red-600 animate-pulse'
                    : 'bg-[#3a7aaf] hover:bg-[#2d6290] disabled:bg-[#c0c0c0]'
                } disabled:cursor-not-allowed`}
                title="Hold to speak, release to submit"
              >
                <svg
                  className="w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"
                  />
                </svg>
              </button>
              <button
                ref={submitButtonRef}
                onClick={() => handleSendMessage()}
                disabled={isLoading || !inputValue.trim()}
                className={`absolute right-1 top-1 w-8 h-8 rounded-md text-white bg-[#3a7aaf] hover:bg-[#2d6290] disabled:bg-[#c0c0c0] disabled:cursor-not-allowed transition-colors flex items-center justify-center overflow-hidden ${isSubmitAnimating ? 'submit-button-animating' : ''}`}
                style={isSubmitAnimating ? { backgroundColor: '#3a7aaf' } : {}}
              >
                <svg
                  className="arrow-icon w-4 h-4"
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={3}
                    d="M5 10l7-7m0 0l7 7m-7-7v18"
                  />
                </svg>
                <div className="square-icon absolute w-4 h-4 bg-white rounded-sm opacity-0" />
              </button>
            </div>
          </div>
        </div>

        {/* Right Column */}
        <div id="right-column" className="flex flex-col">
          {/* Right Top Panel - Output Display */}
          <div
            id="right-top-panel"
            className="bg-white border-l border-gray-200 overflow-hidden relative rounded-[10px]"
          >
            <div className="h-full overflow-hidden relative">
              {renderOutput()}
            </div>
          </div>

          {/* Right Bottom Panel - Code Display */}
          <div id="right-bottom-panel" className="bg-white border-l border-gray-200 overflow-auto p-4 rounded-[10px]">
            {currentCode ? (
              <SyntaxHighlighter
                language="r"
                style={{
                  ...chrome,
                  'hljs-comment': { color: '#5a8c4d' },  // Medium green for comments
                  'hljs-title': { color: '#0066cc' },    // Blue for function names
                  'hljs-function': { color: '#0066cc' }, // Blue for function calls
                  'hljs-name': { color: '#0066cc' },     // Blue for function names
                  'hljs-keyword': { color: '#a626a4' },  // Purple for keywords
                  'hljs-string': { color: '#1328a5' },   // Custom blue for strings
                  'hljs-number': { color: '#986801' },   // Orange for numbers
                }}
                customStyle={{
                  fontSize: '10pt',
                  padding: '16px',
                  borderRadius: '4px',
                  border: '1px solid #d1d5db',
                  margin: 0
                }}
                showLineNumbers={true}
              >
                {currentCode}
              </SyntaxHighlighter>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center">
                  <p>No code selected</p>
                  <p className="text-sm mt-2">Select a code card to view the code</p>
                </div>
              </div>
            )}
          </div>
        </div>
        </div>

      {/* Hidden file input for load data */}
      <input
        ref={fileInputRef}
        type="file"
        accept=".csv,.txt,.tsv"
        onChange={handleFileSelect}
        style={{ display: 'none' }}
      />

      {/* API Key Modal */}
      <ApiKeyModal
        isOpen={showApiKeyModal}
        onSave={handleSaveApiKey}
        onCancel={() => {
          if (apiKey) {
            setShowApiKeyModal(false);
          }
        }}
      />

      {/* Snowflake Browser Modal */}
      <SnowflakeBrowserModal
        isOpen={showSnowflakeModal}
        onClose={() => setShowSnowflakeModal(false)}
        onLoad={handleLoadSnowflakeTables}
      />
    </div>
  );
}

export default App;
