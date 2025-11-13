import React, { useState, useEffect, useRef } from 'react';
import Split from 'split.js';
import ApiKeyModal from './components/ApiKeyModal';
import CodeCard from './components/CodeCard';
import { sendMessageToClaude } from './utils/claudeApi';
import { executeRCode } from './utils/rExecutor';

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

  // Refs for resizable panels
  const splitInstanceRef = useRef(null);
  const splitVerticalInstanceRef = useRef(null);
  const textareaRef = useRef(null);

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

  // Handle API key save
  const handleSaveApiKey = (key) => {
    setApiKey(key);
    localStorage.setItem('anthropic_api_key', key);
    setShowApiKeyModal(false);
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
      // Send to Claude API
      const response = await sendMessageToClaude(
        apiKey,
        userMessage,
        messages.map(m => ({ role: m.role, content: m.content }))
      );

      // Create code cards for any R code blocks
      const newCards = response.rCodeBlocks.length > 0
        ? response.rCodeBlocks.map((block, index) => ({
            id: `card-${Date.now()}-${index}`,
            code: block.code,
            summary: block.summary,
            output: null
          }))
        : [];

      // Strip R code blocks from the displayed message text
      const messageText = response.text.replace(/```r\n[\s\S]*?\n```/g, '').trim();

      // Add assistant response to chat with embedded code cards
      const assistantMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: messageText,
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

  // Render chat messages
  const renderMessage = (message) => {
    return (
      <div key={message.id} className="mb-4">
        {/* Message bubble */}
        <div className={`${message.role === 'user' ? 'text-right' : 'text-left'}`}>
          <div
            className={`inline-block max-w-[80%] p-3 rounded-lg text-base ${
              message.role === 'user'
                ? 'bg-blue-600 text-white'
                : 'bg-gray-200 text-gray-800'
            }`}
          >
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
          </div>
        </div>

        {/* Code cards inline (if any) */}
        {message.codeCards && message.codeCards.length > 0 && (
          <div className="mt-3 space-y-2">
            {message.codeCards.map(card => (
              <CodeCard
                key={card.id}
                id={card.id}
                summary={card.summary}
                code={card.code}
                isSelected={card.id === selectedCardId}
                onClick={handleCardSelect}
              />
            ))}
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
            <svg
              className="w-16 h-16 mx-auto mb-4 text-gray-400"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z"
              />
            </svg>
            <p>No output yet</p>
            <p className="text-sm mt-2">Select a code card to view its output</p>
          </div>
        </div>
      );
    }

    return (
      <div className="h-full overflow-auto p-4">
        {/* Error display */}
        {currentOutput.error && (
          <div className="bg-red-100 border border-red-400 text-red-700 px-4 py-3 rounded mb-4">
            <strong>Error:</strong> {currentOutput.error}
          </div>
        )}

        {/* Plots */}
        {currentOutput.plots && currentOutput.plots.length > 0 && (
          <div className="space-y-4">
            {currentOutput.plots.map((plot, index) => (
              <div
                key={index}
                className="border border-gray-300 rounded p-2 bg-white"
                dangerouslySetInnerHTML={{ __html: plot.data }}
              />
            ))}
          </div>
        )}

        {/* Text output (only show if no plots) */}
        {currentOutput.output && (!currentOutput.plots || currentOutput.plots.length === 0) && (
          <pre className="bg-gray-50 p-4 rounded mb-4 text-base overflow-x-auto">
            {currentOutput.output}
          </pre>
        )}

        {/* Tables */}
        {currentOutput.tables && currentOutput.tables.length > 0 && (
          <div className="space-y-4">
            {currentOutput.tables.map((table, index) => (
              <div key={index} className="overflow-x-auto">
                <table className="min-w-full border border-gray-300">
                  <thead className="bg-gray-100">
                    <tr>
                      {table.headers.map((header, i) => (
                        <th
                          key={i}
                          className="border border-gray-300 px-4 py-2 text-left text-sm font-semibold"
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
                            className="border border-gray-300 px-4 py-2 text-sm"
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
    );
  };

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      {/* Header */}
      <header className="bg-[#f5f8f9] h-[24px] border-b border-[#d7dadc]">
        <div className="flex items-center justify-between h-full px-3">
          <h1 className="text-xs font-semibold text-gray-800">Positronic</h1>
          <button
            onClick={() => setShowApiKeyModal(true)}
            className="px-2 py-0.5 bg-[#3a7aaf] hover:bg-[#2d6290] text-white rounded transition-all text-[10px] font-medium"
          >
            Update API Key
          </button>
        </div>
      </header>

      {/* Main content area */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Panel - Interaction Panel */}
        <div id="left-panel" className="flex flex-col bg-white">
          {/* Messages area */}
          <div className="flex-1 overflow-y-auto p-4">
            {messages.length === 0 && (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center max-w-md">
                  <svg
                    className="w-20 h-20 mx-auto mb-4 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z"
                    />
                  </svg>
                  <h2 className="text-xl font-semibold mb-2">Welcome to Positronic</h2>
                  <p className="text-sm">
                    Start a conversation with Claude to analyze data, create visualizations,
                    and generate insights using R code.
                  </p>
                </div>
              </div>
            )}

            {messages.map(renderMessage)}

            {isLoading && (
              <div className="flex items-center gap-2 text-gray-500 mb-4">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
                <span>Claude is thinking...</span>
              </div>
            )}
          </div>

          {/* Input area */}
          <div className="border-t border-gray-200 p-4 bg-gray-50">
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onKeyPress={handleKeyPress}
                placeholder="Ask Positronic..."
                className="w-full px-4 py-3 pr-12 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none bg-white overflow-hidden"
                style={{ fontSize: '11pt' }}
                rows="1"
                disabled={isLoading}
              />
              <button
                onClick={handleSendMessage}
                disabled={isLoading || !inputValue.trim()}
                className="absolute right-2 top-2 w-8 h-8 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors flex items-center justify-center"
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
          <div id="right-top-panel" className="bg-white border-l border-gray-200 overflow-hidden">
            <div className="h-full overflow-hidden">
              {renderOutput()}
            </div>
          </div>

          {/* Right Bottom Panel - Code Display */}
          <div id="right-bottom-panel" className="bg-white border-l border-gray-200 overflow-auto p-4">
            {currentCode ? (
              <pre className="bg-white text-gray-900 p-4 rounded text-base overflow-x-auto border border-gray-300">
                <code>{currentCode}</code>
              </pre>
            ) : (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center">
                  <svg
                    className="w-16 h-16 mx-auto mb-4 text-gray-400"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      strokeWidth={2}
                      d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4"
                    />
                  </svg>
                  <p>No code selected</p>
                  <p className="text-sm mt-2">Select a code card to view the code</p>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

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
