# 3Panel Data Analyzer

A modern web application that provides a chat interface to Claude AI, allowing users to analyze data files, generate visualizations, and execute R code through an intuitive three-panel layout.

## Features

- **Three-Panel Layout**: Resizable panels for optimal workspace organization
  - Left Panel: Chat interface with Claude
  - Right Top Panel: Visualization and output display
  - Right Bottom Panel: R code viewer

- **Claude AI Integration**: Natural language interaction for data analysis tasks

- **R Code Execution**: Automatic generation and execution of R code (mock implementation included)

- **Code Cards**: Visual representation of generated code snippets with easy selection

- **API Key Management**: Secure storage and management of Anthropic API keys

## Technology Stack

### Frontend
- **React 18** - Modern UI framework with hooks
- **Tailwind CSS** - Utility-first styling
- **Split.js** - Resizable panel functionality
- **Vite** - Fast build tool and dev server

### Backend
- **Express** - Node.js web framework for proxy server
- **Anthropic SDK** - Official SDK for Claude AI integration
- **CORS** - Cross-origin resource sharing middleware

## Project Structure

```
3Panel/
├── src/
│   ├── components/
│   │   ├── ApiKeyModal.jsx      # API key input modal
│   │   └── CodeCard.jsx         # Code snippet card component
│   ├── utils/
│   │   ├── claudeApi.js         # Claude API integration via proxy
│   │   └── rExecutor.js         # R code execution (mock)
│   ├── App.jsx                  # Main application component
│   ├── main.jsx                 # Application entry point
│   └── index.css                # Global styles
├── server.js                    # Express proxy server for API calls
├── index.html                   # HTML template
├── package.json                 # Dependencies
├── vite.config.js              # Vite configuration
├── tailwind.config.js          # Tailwind CSS configuration
└── postcss.config.js           # PostCSS configuration
```

## Getting Started

### Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- An Anthropic API key (get one at https://console.anthropic.com/)

### Installation

1. **Install dependencies**:
   ```bash
   npm install
   ```

2. **Start both frontend and backend servers**:
   ```bash
   npm run dev
   ```
   This will start:
   - Backend proxy server on `http://localhost:3001`
   - Frontend React app on `http://localhost:3000`

3. **Open your browser**:
   Navigate to `http://localhost:3000`

4. **Enter your API key**:
   On first launch, you'll be prompted to enter your Anthropic API key. This key is stored locally in your browser.

### Architecture

The app uses a **client-server architecture** to avoid CORS issues:

1. **Frontend (React)** - Runs on port 3000
   - Sends chat messages to the backend proxy
   - Displays responses and executes R code

2. **Backend (Express)** - Runs on port 3001
   - Proxies requests to the Anthropic API
   - Handles API authentication
   - Returns responses to the frontend

This architecture keeps your API key secure and avoids browser CORS restrictions.

## Usage

### Basic Workflow

1. **Enter a prompt** in the chat interface, such as:
   - "Load the sales data from data.csv and show me summary statistics"
   - "Create a scatter plot showing the relationship between variables"
   - "Analyze the distribution of values in my dataset"

2. **View the response** from Claude in the chat panel

3. **Interact with code cards**:
   - Generated R code appears as clickable cards
   - Click a card to select it (blue border indicates selection)
   - Selected card's code appears in the bottom-right panel

4. **View outputs**:
   - Charts and visualizations appear in the top-right panel
   - Text output and tables are also displayed

### Panel Resizing

- Drag the vertical divider to resize left and right sections
- Drag the horizontal divider in the right column to resize top and bottom panels
- Panels remember their sizes during the session

### Updating API Key

Click the "Update API Key" button in the header to change your stored API key at any time.

## Example Prompts

Try these example prompts to see the application in action:

1. **Data Loading**:
   ```
   Load a CSV file called 'iris.csv' and show me the first few rows
   ```

2. **Visualization**:
   ```
   Create a beautiful scatter plot showing the relationship between sepal length and sepal width
   ```

3. **Statistical Analysis**:
   ```
   Calculate summary statistics for all numeric variables in the dataset
   ```

4. **Advanced Plots**:
   ```
   Create a bar chart showing the count of each species, with different colors for each category
   ```

## Current Implementation Notes

### Mock R Execution

The current implementation uses a **mock R executor** that simulates R code execution and generates sample visualizations. This allows the application to work without requiring an R backend or WebR installation.

**Mock features include**:
- Scatter plots
- Bar charts
- Line plots
- Data summaries
- Statistical output

### Upgrading to Real R Execution

To integrate with actual R code execution, you can:

1. **Use WebR** (R in the browser):
   ```bash
   npm install @r-wasm/webr
   ```
   Then replace the mock implementation in [src/utils/rExecutor.js](src/utils/rExecutor.js) with actual WebR calls.

2. **Use a Backend Service**:
   Set up an R server (e.g., using Plumber or OpenCPU) and modify the executor to make API calls to your backend.

## Development

### Available Scripts

- `npm run dev` - Start both frontend and backend servers concurrently
- `npm run client` - Start only the frontend (Vite) on port 3000
- `npm run server` - Start only the backend (Express) on port 3001
- `npm run build` - Build frontend for production
- `npm run preview` - Preview production build

### Running Servers Separately

For development, you can run the servers in separate terminals:

**Terminal 1 - Backend:**
```bash
npm run server
```

**Terminal 2 - Frontend:**
```bash
npm run client
```

### Building for Production

```bash
npm run build
```

The built files will be in the `dist/` directory, ready to deploy to any static hosting service.

## API Key Security

- API keys are stored in browser localStorage
- Keys are never transmitted except to the official Anthropic API
- Consider implementing additional security measures for production use

## Browser Compatibility

- Chrome/Edge (latest)
- Firefox (latest)
- Safari (latest)

## Troubleshooting

### Connection Errors

If you see "Cannot connect to proxy server" or "Failed to fetch":
1. Make sure **both** servers are running (`npm run dev` runs both)
2. Check that the backend is running on port 3001
3. Check that the frontend is running on port 3000
4. Verify nothing else is using these ports

To test the backend is running, visit: http://localhost:3001/health

**Port Conflicts:**
If ports 3000 or 3001 are already in use, you can:
```bash
# Kill processes on those ports
lsof -ti:3000,3001 | xargs kill -9

# Or use the provided start script
./start.sh
```

### API Key Issues

If you receive authentication errors:
1. Click "Update API Key" in the header
2. Verify your key is correct at https://console.anthropic.com/
3. Check that your key has proper permissions and has credits available

### Model Not Found Errors (404)

If you see errors like "model: claude-3-haiku-20240307 not found":

**Test which models your API key has access to:**
```bash
node test-api-key.js
```
This will test all available Claude models and show which ones work with your API key.

**Common causes:**
- New API keys may have limited model access initially
- Some accounts have region-specific model availability
- Your account may need activation or credits

**Solutions:**
1. Visit https://console.anthropic.com/ to check your account status
2. Verify you have credits/billing set up
3. Contact Anthropic support if models are unexpectedly unavailable
4. Try a different API key if you have one

**Update the model in server.js:**
Once you know which model works, update line 80 in [server.js](server.js):
```javascript
model: 'YOUR-WORKING-MODEL-NAME',
```

### Build Issues

If you encounter build errors:
```bash
rm -rf node_modules package-lock.json
npm install
npm run dev
```

## Future Enhancements

- [ ] File upload functionality for local data files
- [ ] Real WebR integration for actual R code execution
- [ ] Export functionality for charts and outputs
- [ ] Code editing and re-execution
- [ ] Chat history persistence
- [ ] Multiple conversation threads
- [ ] Dark mode support

## License

MIT License - feel free to use this project for your own purposes.

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.

## Support

For issues and questions:
- Check the [Anthropic API documentation](https://docs.anthropic.com/)
- Review the inline code comments
- Open an issue in the repository

---

**Built with Claude Code** - An AI-powered development assistant by Anthropic
