import React, { useState, useEffect, useRef } from 'react';
import Split from 'split.js';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import r from 'react-syntax-highlighter/dist/esm/languages/hljs/r';
import chrome from 'react-syntax-highlighter/dist/esm/styles/hljs/atom-one-light';
import ReactMarkdown from 'react-markdown';
import ApiKeyModal from './components/ApiKeyModal';
import CodeCard from './components/CodeCard';
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
  const [suggestionsEnabled, setSuggestionsEnabled] = useState(false);
  const [showConversationsMenu, setShowConversationsMenu] = useState(false);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const [favoritedCardIds, setFavoritedCardIds] = useState(new Set());

  // Refs for resizable panels
  const splitInstanceRef = useRef(null);
  const splitVerticalInstanceRef = useRef(null);
  const textareaRef = useRef(null);
  const leftPanelRef = useRef(null);
  const cardRefsRef = useRef({});
  const fileInputRef = useRef(null);

  // Helper function to determine suggestion icon based on content
  const getSuggestionIcon = (suggestion) => {
    const lowerSuggestion = suggestion.toLowerCase();

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
  }, []);

  // Auto-resize textarea based on content
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
    }
  }, [inputValue]);

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

  // Initialize Split.js for resizable panels
  useEffect(() => {
    // Horizontal split (left panel | right column)
    if (!splitInstanceRef.current) {
      splitInstanceRef.current = Split(['#left-panel', '#right-column'], {
        sizes: [50, 50],
        minSize: [300, 300],
        gutterSize: 8,
        cursor: 'col-resize'
      });
    }

    // Vertical split (right top panel | right bottom panel)
    if (!splitVerticalInstanceRef.current) {
      splitVerticalInstanceRef.current = Split(['#right-top-panel', '#right-bottom-panel'], {
        direction: 'vertical',
        sizes: [50, 50],
        minSize: [100, 100],
        gutterSize: 8,
        cursor: 'row-resize'
      });
    }

    // Cleanup
    return () => {
      if (splitInstanceRef.current) {
        splitInstanceRef.current.destroy();
        splitInstanceRef.current = null;
      }
      if (splitVerticalInstanceRef.current) {
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

  // Handle API key save
  const handleSaveApiKey = (key) => {
    setApiKey(key);
    localStorage.setItem('anthropic_api_key', key);
    setShowApiKeyModal(false);
  };

  // Handle file selection for load data
  const handleFileSelect = async (event) => {
    const file = event.target.files[0];
    if (file) {
      try {
        let filename = file.name;

        // Check if file already exists in data folder
        const checkResponse = await fetch(`http://localhost:3001/api/check-file/${encodeURIComponent(filename)}`);
        const checkResult = await checkResponse.json();

        if (!checkResult.exists) {
          // File doesn't exist, upload it
          const formData = new FormData();
          formData.append('file', file);

          const uploadResponse = await fetch('http://localhost:3001/api/upload-data', {
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
        const loadMessage = `Loaded ${filename}`;
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
          const response = await fetch('http://localhost:3001/api/load-and-report-data', {
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

          // Add assistant response with the accurate report
          const assistantMessage = {
            id: Date.now() + 1,
            role: 'assistant',
            content: result.report,
            displayContent: result.report,
            codeCards: [diagnosticCard],
            suggestions: result.suggestions || []
          };
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
      await fetch('http://localhost:3001/api/clear-workspace', {
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
  const handleSuggestionClick = (suggestion) => {
    setInputValue(suggestion);
    // Focus the textarea
    if (textareaRef.current) {
      textareaRef.current.focus();
    }
  };

  // Toggle options menu
  const handleToggleOptions = () => {
    setShowOptionsMenu(!showOptionsMenu);
  };

  // Handle sending a message to Claude
  const handleSendMessage = async () => {
    if (!inputValue.trim() || isLoading) return;

    const userMessage = inputValue.trim();
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
      const recentPlots = [];
      for (const card of codeCards.slice(-3)) {
        if (card.output && card.output.plots) {
          for (const plot of card.output.plots) {
            if (plot.pngBase64) {
              recentPlots.push({
                base64Data: plot.pngBase64,
                summary: card.summary
              });
            }
          }
        }
      }

      // Send to Claude API with plot images
      const response = await sendMessageToClaude(
        apiKey,
        userMessage,
        messages.map(m => ({ role: m.role, content: m.content })),
        suggestionsEnabled,
        recentPlots  // Pass recent plots for Claude to see
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
      // Matches both ```r and ```R with optional whitespace
      const displayText = response.text.replace(/```[rR]\s*\n[\s\S]*?```/g, '').trim();

      // Debug: Log if suggestions are enabled and what the message contains
      console.log('Suggestions enabled:', suggestionsEnabled);
      console.log('Message text after stripping code:', displayText);

      // Add assistant response to chat with embedded code cards
      // Store both original text (for API) and display text (for rendering)
      const assistantMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: response.text,  // Keep original for API
        displayContent: displayText,  // Stripped version for display
        codeCards: newCards  // Attach code cards to this message
      };
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
      // Execute the code via backend
      const result = await executeRCode(code);
      setCurrentOutput(result);

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
    const suggestionsMatch = content.match(/\*\*Suggestions for further analysis:\*\*\s*([\s\S]*?)(?:\n\n|$)/);
    if (!suggestionsMatch) return { mainContent: content, suggestions: [] };

    const mainContent = content.replace(/\*\*Suggestions for further analysis:\*\*\s*[\s\S]*$/, '').trim();
    const suggestionsText = suggestionsMatch[1];
    const suggestions = suggestionsText
      .split('\n')
      .filter(line => line.trim().startsWith('-'))
      .map(line => line.replace(/^-\s*/, '').trim());

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
          ? { mainContent: contentToDisplay, suggestions: message.suggestions }
          : parseSuggestions(contentToDisplay))
      : { mainContent: contentToDisplay, suggestions: [] };

    return (
      <div key={message.id} className="mb-4">
        {/* Message bubble */}
        <div className={`${message.role === 'user' ? 'text-right' : 'text-left'}`}>
          <div
            className={`inline-block max-w-[80%] p-3 rounded-lg ${
              message.role === 'user'
                ? 'bg-[#add7fd] text-gray-800'
                : 'bg-white text-gray-800'
            }`}
            style={{ fontSize: '11pt' }}
          >
            <div className="whitespace-pre-wrap break-words">
              <ReactMarkdown>{mainContent}</ReactMarkdown>
            </div>
          </div>
        </div>

        {/* Code cards inline (if any) */}
        {message.codeCards && message.codeCards.length > 0 && (
          <div className="mt-3 space-y-2 max-w-[80%]">
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

        {/* Suggestions (if any) */}
        {suggestions.length > 0 && (
          <div className="mt-3 ml-0 max-w-2xl" style={{ fontSize: '10pt' }}>
            <p className="font-semibold text-gray-700 mb-2">Suggestions for further analysis:</p>
            <div className="grid grid-cols-2 gap-3">
              {suggestions.map((suggestion, index) => {
                const iconName = getSuggestionIcon(suggestion);
                return (
                  <button
                    key={index}
                    onClick={() => handleSuggestionClick(suggestion)}
                    className="suggestion-button flex items-start gap-2 text-left text-blue-600 hover:text-blue-800 hover:underline cursor-pointer p-2"
                  >
                    <img
                      src={`/${iconName}.svg`}
                      alt={iconName}
                      className="w-8 h-8 flex-shrink-0"
                    />
                    <span>{suggestion}</span>
                  </button>
                );
              })}
            </div>
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
      <header className="bg-[#edeff0] h-[26px]">
        <div className="flex items-center justify-between h-full px-3">
          <div className="flex items-center gap-2 h-full relative">
            <img
              src="/load-data.png"
              alt="Load data"
              className="h-4 cursor-pointer"
              onClick={handleLoadData}
            />
            <img src="/separator.png" alt="" className="h-4" />
            <img
              src="/new-conversation.png"
              alt="New conversation"
              className="h-4 cursor-pointer"
              onClick={handleNewConversation}
            />
            <div className="relative conversations-menu-container">
              <img
                src="/conversations.png"
                alt="Conversations"
                className="h-4 cursor-pointer"
                onClick={handleToggleConversations}
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
            />
            <div className="relative options-menu-container">
              <img
                src="/options.png"
                alt="Options"
                className="h-4 cursor-pointer"
                onClick={handleToggleOptions}
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
              onClick={handleToggleFavorite}
              className="w-6 h-6 flex items-center justify-center hover:bg-gray-200 rounded transition-colors"
              disabled={!selectedCardId}
            >
              <img
                src={selectedCardId && favoritedCardIds.has(selectedCardId) ? "/favorite-on.png" : "/favorite-off.png"}
                alt="Favorite"
                className="w-4 h-4"
              />
            </button>
            <button className="w-6 h-6 flex items-center justify-center hover:bg-gray-200 rounded transition-colors" disabled={!selectedCardId}>
              <img src="/copy-plot.png" alt="Copy plot" className="w-4 h-4" />
            </button>
            <button className="w-6 h-6 flex items-center justify-center hover:bg-gray-200 rounded transition-colors" disabled={!selectedCardId}>
              <img src="/check-code.png" alt="Check code" className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowApiKeyModal(true)}
              className="px-2 py-0.5 bg-[#edeff0] hover:bg-[#d7dadc] text-[#3a7aaf] border border-[#d7dadc] rounded transition-all text-[10px] font-medium ml-2"
            >
              Update API Key
            </button>
          </div>
        </div>
      </header>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Interaction Panel */}
        <div id="left-panel" ref={leftPanelRef} tabIndex={0} className="flex flex-col bg-white focus:outline-none rounded-[10px]">
          {/* Messages area */}
          <div className="flex-1 overflow-y-auto p-4">
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

                  {/* Startup suggestions */}
                  <div className="mt-4" style={{ fontSize: '10pt' }}>
                    <div className="grid grid-cols-2 gap-3">
                      {[
                        'Create a dot plot for mileage vs horsepower using mtcars color the dots on a gradient from red to blue',
                        'Show the first 25 rows of mtcars',
                        'Create a histogram of vehicle weights from mtcars',
                        'Load Air_Quality.csv and show first 25 rows formatted with gt'
                      ].map((suggestion, index) => {
                        const iconName = getSuggestionIcon(suggestion);
                        return (
                          <button
                            key={index}
                            onClick={() => setInputValue(suggestion)}
                            className="suggestion-button flex items-start gap-2 text-left text-blue-600 hover:text-blue-800 hover:underline cursor-pointer p-2"
                          >
                            <img
                              src={`/${iconName}.svg`}
                              alt={iconName}
                              className="w-8 h-8 flex-shrink-0"
                            />
                            <span>{suggestion}</span>
                          </button>
                        );
                      })}
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
                onChange={(e) => setInputValue(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Ask Positronic..."
                className="w-full px-3 py-2 pr-12 border border-[#616161] rounded-lg focus:outline-none resize-none bg-white overflow-hidden"
                style={{ fontSize: '11pt', minHeight: 'calc(2.5rem + 1px)' }}
                rows="1"
                disabled={isLoading}
              />
              <button
                onClick={handleSendMessage}
                disabled={isLoading || !inputValue.trim()}
                className="absolute right-1 top-1 w-8 h-8 rounded-md text-white bg-[#3a7aaf] hover:bg-[#2d6290] disabled:bg-[#c0c0c0] disabled:cursor-not-allowed transition-colors flex items-center justify-center"
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
                    strokeWidth={3}
                    d="M5 10l7-7m0 0l7 7m-7-7v18"
                  />
                </svg>
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
    </div>
  );
}

export default App;
