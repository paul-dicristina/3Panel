import React, { useState, useEffect } from 'react';

const SnowflakeBrowserModal = ({ isOpen, onClose, onLoad }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [treeData, setTreeData] = useState([]);
  const [expandedNodes, setExpandedNodes] = useState(new Set());
  const [selectedItems, setSelectedItems] = useState([]);
  const [error, setError] = useState(null);

  // Load databases when modal opens
  useEffect(() => {
    if (isOpen) {
      loadDatabases();
    }
  }, [isOpen]);

  const loadDatabases = async () => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch('http://localhost:3001/api/execute-r', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: `
library(jsonlite)

# Connect if not already connected
if (!exists(".snowflake_config") || !.snowflake_config$connected) {
  snowflake_connect()
}

# Get databases
databases <- sf_databases()
cat(toJSON(databases, auto_unbox = TRUE))
`,
          autoFormatTabular: false
        })
      });

      const result = await response.json();

      if (result.error) {
        setError(result.error);
        return;
      }

      // Parse JSON from output - find the JSON array
      const jsonMatch = result.output ? result.output.match(/\[[\s\S]*?\](?=\s*$|\s*\n)/) : null;
      if (jsonMatch) {
        try {
          const databases = JSON.parse(jsonMatch[0]);

          // Transform to tree structure
          const tree = databases.map(db => ({
            id: `db-${db.name}`,
            name: db.name,
            type: 'database',
            children: null, // Lazy load
            isLoaded: false
          }));

          setTreeData(tree);
        } catch (e) {
          console.error('Error parsing databases JSON:', e);
          setError('Failed to parse database list');
        }
      } else {
        setError('No database list found in response');
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  };

  const loadSchemas = async (database) => {
    console.log(`Loading schemas for ${database}`);
    try {
      const response = await fetch('http://localhost:3001/api/execute-r', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: `
library(jsonlite)
tryCatch({
  result <- sf_query("SHOW SCHEMAS IN DATABASE ${database}")
  cat("Schemas query returned ", nrow(result), " rows\\n")
  cat(toJSON(result, auto_unbox = TRUE))
}, error = function(e) {
  # Return empty array for permission errors
  cat("[]")
})
`,
          autoFormatTabular: false
        })
      });

      const result = await response.json();
      console.log('Schemas result for', database, ':', result);

      // Extract JSON from output - find the JSON array
      let schemas = [];
      if (result.output) {
        // Look for JSON array pattern
        const jsonMatch = result.output.match(/\[[\s\S]*?\](?=\s*$|\s*\n)/);

        if (jsonMatch) {
          console.log('Schemas JSON found: Yes');
          try {
            schemas = JSON.parse(jsonMatch[0]);
            console.log('Parsed schemas:', schemas.length);
          } catch (e) {
            console.error('JSON parse error:', e);
            return [];
          }
        } else {
          console.log('Schemas JSON found: No');
          return [];
        }
      }

      if (schemas.length === 0) {
        console.log('No schemas found or no access to', database);
        return [];
      }

      return schemas.map(schema => ({
        id: `schema-${database}-${schema.name}`,
        name: schema.name,
        type: 'schema',
        database: database,
        children: null,
        isLoaded: false
      }));
    } catch (err) {
      console.error('Error loading schemas for', database, ':', err);
      return [];
    }
  };

  const loadTables = async (database, schema) => {
    console.log(`Loading tables for ${database}.${schema}`);
    try {
      const response = await fetch('http://localhost:3001/api/execute-r', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: `
library(jsonlite)

tryCatch({
  all_items <- list()

  # Get tables
  tables_result <- sf_query("SHOW TABLES IN ${database}.${schema}")
  cat("Tables query returned ", nrow(tables_result), " rows\\n")

  if (nrow(tables_result) > 0) {
    for (i in 1:nrow(tables_result)) {
      all_items[[length(all_items) + 1]] <- list(
        name = as.character(tables_result$name[i]),
        type = "TABLE",
        rows = ifelse(is.na(tables_result$rows[i]), 0, as.numeric(tables_result$rows[i]))
      )
    }
  }

  # Get views
  views_result <- sf_query("SHOW VIEWS IN ${database}.${schema}")
  cat("Views query returned ", nrow(views_result), " rows\\n")

  if (nrow(views_result) > 0) {
    for (i in 1:nrow(views_result)) {
      all_items[[length(all_items) + 1]] <- list(
        name = as.character(views_result$name[i]),
        type = "VIEW",
        rows = ifelse(is.na(views_result$rows[i]), 0, as.numeric(views_result$rows[i]))
      )
    }
  }

  cat(toJSON(all_items, auto_unbox = TRUE))
}, error = function(e) {
  cat("Error: ", e$message, "\\n")
  cat("[]")
})
`,
          autoFormatTabular: false
        })
      });

      const result = await response.json();
      console.log('Tables result for', database, '.', schema, ':', result);

      // Extract JSON from output - find the JSON array
      let items = [];
      if (result.output) {
        // Look for JSON array pattern
        const jsonMatch = result.output.match(/\[[\s\S]*?\](?=\s*$|\s*\n)/);

        if (jsonMatch) {
          console.log('Tables JSON found: Yes');
          try {
            items = JSON.parse(jsonMatch[0]);
            console.log('Parsed items:', items);
          } catch (e) {
            console.error('JSON parse error:', e);
            return [];
          }
        } else {
          console.log('Tables JSON found: No');
          return [];
        }
      }

      if (!Array.isArray(items) || items.length === 0) {
        console.log('No tables/views found for', database, '.', schema);
        return [];
      }

      return items.map(item => ({
        id: `${item.type.toLowerCase()}-${database}-${schema}-${item.name}`,
        name: item.name,
        type: item.type.toLowerCase(),
        database: database,
        schema: schema,
        rows: item.rows || 0
      }));
    } catch (err) {
      console.error('Error loading tables for', database, '.', schema, ':', err);
      return [];
    }
  };

  const toggleNode = async (node) => {
    console.log('Toggle node:', node.type, node.name, 'isLoaded:', node.isLoaded);

    const newExpanded = new Set(expandedNodes);

    if (newExpanded.has(node.id)) {
      // Collapse
      console.log('Collapsing node:', node.id);
      newExpanded.delete(node.id);
    } else {
      // Expand
      console.log('Expanding node:', node.id);
      newExpanded.add(node.id);

      // Load children if not loaded
      if (!node.isLoaded) {
        console.log('Loading children for', node.type);

        if (node.type === 'database') {
          const schemas = await loadSchemas(node.name);
          console.log('Loaded', schemas.length, 'schemas');
          setTreeData(prev => prev.map(db =>
            db.id === node.id
              ? { ...db, children: schemas, isLoaded: true }
              : db
          ));
        } else if (node.type === 'schema') {
          const tables = await loadTables(node.database, node.name);
          console.log('Loaded', tables.length, 'tables/views');
          setTreeData(prev => prev.map(db => {
            if (db.id === `db-${node.database}`) {
              return {
                ...db,
                children: db.children.map(schema =>
                  schema.id === node.id
                    ? { ...schema, children: tables, isLoaded: true }
                    : schema
                )
              };
            }
            return db;
          }));
        }
      } else {
        console.log('Node already loaded, just expanding');
      }
    }

    setExpandedNodes(newExpanded);
  };

  const toggleSelection = (item, event) => {
    if (item.type !== 'table' && item.type !== 'view') return;

    const isMultiSelect = event.shiftKey || event.ctrlKey || event.metaKey;

    setSelectedItems(prev => {
      const exists = prev.find(i => i.id === item.id);

      if (exists) {
        return prev.filter(i => i.id !== item.id);
      } else {
        if (isMultiSelect) {
          return [...prev, item];
        } else {
          return [item];
        }
      }
    });
  };

  const handleLoad = () => {
    if (selectedItems.length > 0) {
      onLoad(selectedItems);
      onClose();
    }
  };

  const renderNode = (node, level = 0) => {
    const isExpanded = expandedNodes.has(node.id);
    const isSelected = selectedItems.some(item => item.id === node.id);
    const isSelectable = node.type === 'table' || node.type === 'view';

    let icon;
    if (node.type === 'database') {
      icon = '/sf_db.png';
    } else if (node.type === 'schema') {
      icon = '/sf_schema.png';
    } else if (node.type === 'table') {
      icon = '/sf_table.png';
    } else if (node.type === 'view') {
      icon = '/sf_view.png';
    }

    const carat = (node.type === 'database' || node.type === 'schema')
      ? (isExpanded ? '/carat_open.png' : '/carat_closed.png')
      : null;

    return (
      <div key={node.id}>
        <div
          className={`flex items-center py-1 px-2 cursor-pointer ${
            isSelected ? 'bg-[#29b5e8] text-white' : 'hover:bg-gray-100'
          }`}
          style={{ paddingLeft: `${level * 20 + 8}px` }}
          onClick={(e) => {
            if (isSelectable) {
              toggleSelection(node, e);
            } else {
              toggleNode(node);
            }
          }}
        >
          {carat && (
            <img
              src={carat}
              alt=""
              className="w-3 h-3 mr-2"
              onClick={(e) => {
                e.stopPropagation();
                toggleNode(node);
              }}
            />
          )}
          {!carat && <span className="w-3 mr-2"></span>}

          <img
            src={icon}
            alt=""
            className="w-4 h-4 mr-2"
            style={isSelected ? { filter: 'brightness(0) invert(1)' } : {}}
          />

          <span className="flex-1" style={{ fontSize: '11pt' }}>{node.name}</span>

          {node.rows !== undefined && (
            <span className={`text-sm ${isSelected ? 'text-white' : 'text-gray-500'}`} style={{ fontSize: '11pt' }}>
              {Number(node.rows).toLocaleString()} rows
            </span>
          )}
        </div>

        {isExpanded && node.children && (
          <div>
            {node.children.map(child => renderNode(child, level + 1))}
          </div>
        )}
      </div>
    );
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
      <div className="bg-[#ecf2f4] rounded-lg shadow-xl w-[960px] h-[720px] flex flex-col">
        {/* Header */}
        <div className="p-4 flex items-center flex-shrink-0">
          <img src="/snowflake-logo-color-rgb.svg" alt="Snowflake" className="h-8" />
        </div>

        {/* Tree View */}
        <div className="flex-1 min-h-0 px-4 py-2 flex flex-col">
          <div className="bg-white border border-gray-300 rounded flex-1 min-h-0 overflow-auto relative">
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center">
                <style>{`
                  @keyframes snowflake-pulse {
                    0%, 100% { transform: scale(1); }
                    50% { transform: scale(1.15); }
                  }
                `}</style>
                <img
                  src="/snowflake-bug-color-rgb.svg"
                  alt="Loading..."
                  className="h-10"
                  style={{
                    animation: 'snowflake-pulse 1.5s ease-in-out infinite'
                  }}
                />
              </div>
            )}

            {error && (
              <div className="text-red-600 p-4">
                Error: {error}
              </div>
            )}

            {!isLoading && !error && treeData.length > 0 && (
              <>
                {treeData.map(node => renderNode(node))}
              </>
            )}

            {!isLoading && !error && treeData.length === 0 && (
              <div className="text-gray-500 text-center p-4">
                No databases found
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 flex items-center justify-between flex-shrink-0">
          <div className="text-sm text-gray-600">
            <div>{selectedItems.length} item{selectedItems.length !== 1 ? 's' : ''} selected</div>
            <div className="text-xs text-gray-500 mt-1">
              Use Shift or Cmd/Ctrl to select multiple items
            </div>
          </div>

          <div className="flex gap-4">
            <button
              onClick={onClose}
              className="w-24 px-4 py-2 bg-white border border-gray-300 rounded hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              onClick={handleLoad}
              disabled={selectedItems.length === 0}
              className="w-24 px-4 py-2 bg-[#29b5e8] text-white rounded hover:bg-[#1da5d8] disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Open
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SnowflakeBrowserModal;
