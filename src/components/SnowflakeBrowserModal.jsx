import React, { useState, useEffect } from 'react';

const SnowflakeBrowserModal = ({ isOpen, onClose, onLoad }) => {
  const [isLoading, setIsLoading] = useState(false);
  const [treeData, setTreeData] = useState([]);
  const [expandedNodes, setExpandedNodes] = useState(new Set());
  const [selectedItems, setSelectedItems] = useState([]);
  const [error, setError] = useState(null);
  const [loadingNodeId, setLoadingNodeId] = useState(null);
  const [searchTerm, setSearchTerm] = useState('');

  // Load databases when modal opens
  useEffect(() => {
    if (isOpen) {
      loadDatabases();
      setLoadingNodeId(null);
    } else {
      // Clear state when modal closes
      setLoadingNodeId(null);
      setExpandedNodes(new Set());
      setSelectedItems([]);
      setSearchTerm('');
    }
  }, [isOpen]);

  // Handle ESC key to close modal
  useEffect(() => {
    const handleEscKey = (event) => {
      if (event.key === 'Escape' && isOpen) {
        onClose();
      }
    };

    if (isOpen) {
      document.addEventListener('keydown', handleEscKey);
    }

    return () => {
      document.removeEventListener('keydown', handleEscKey);
    };
  }, [isOpen, onClose]);

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

all_items <- list()

# Query all object types with individual error handling
# Each query wrapped in tryCatch so failures don't stop other queries

# 1. Get regular tables
tryCatch({
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
}, error = function(e) {
  cat("Tables query error: ", e$message, "\\n")
})

# 2. Get views
tryCatch({
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
}, error = function(e) {
  cat("Views query error: ", e$message, "\\n")
})

# 3. Get materialized views
tryCatch({
  mviews_result <- sf_query("SHOW MATERIALIZED VIEWS IN ${database}.${schema}")
  cat("Materialized views query returned ", nrow(mviews_result), " rows\\n")

  if (nrow(mviews_result) > 0) {
    for (i in 1:nrow(mviews_result)) {
      all_items[[length(all_items) + 1]] <- list(
        name = as.character(mviews_result$name[i]),
        type = "MATERIALIZED_VIEW",
        rows = ifelse(is.na(mviews_result$rows[i]), 0, as.numeric(mviews_result$rows[i]))
      )
    }
  }
}, error = function(e) {
  cat("Materialized views query error: ", e$message, "\\n")
})

# 4. Get external tables
tryCatch({
  ext_tables_result <- sf_query("SHOW EXTERNAL TABLES IN ${database}.${schema}")
  cat("External tables query returned ", nrow(ext_tables_result), " rows\\n")

  if (nrow(ext_tables_result) > 0) {
    for (i in 1:nrow(ext_tables_result)) {
      all_items[[length(all_items) + 1]] <- list(
        name = as.character(ext_tables_result$name[i]),
        type = "EXTERNAL_TABLE",
        rows = ifelse(is.na(ext_tables_result$rows[i]), 0, as.numeric(ext_tables_result$rows[i]))
      )
    }
  }
}, error = function(e) {
  cat("External tables query error: ", e$message, "\\n")
})

# 5. Get dynamic tables
tryCatch({
  dyn_tables_result <- sf_query("SHOW DYNAMIC TABLES IN ${database}.${schema}")
  cat("Dynamic tables query returned ", nrow(dyn_tables_result), " rows\\n")

  if (nrow(dyn_tables_result) > 0) {
    for (i in 1:nrow(dyn_tables_result)) {
      all_items[[length(all_items) + 1]] <- list(
        name = as.character(dyn_tables_result$name[i]),
        type = "DYNAMIC_TABLE",
        rows = ifelse(is.na(dyn_tables_result$rows[i]), 0, as.numeric(dyn_tables_result$rows[i]))
      )
    }
  }
}, error = function(e) {
  cat("Dynamic tables query error: ", e$message, "\\n")
})

# 6. Get streams (change data capture objects)
tryCatch({
  streams_result <- sf_query("SHOW STREAMS IN ${database}.${schema}")
  cat("Streams query returned ", nrow(streams_result), " rows\\n")

  if (nrow(streams_result) > 0) {
    for (i in 1:nrow(streams_result)) {
      all_items[[length(all_items) + 1]] <- list(
        name = as.character(streams_result$name[i]),
        type = "STREAM",
        rows = 0  # Streams don't have row counts
      )
    }
  }
}, error = function(e) {
  cat("Streams query error: ", e$message, "\\n")
})

# 7. Try to get semantic models (Snowflake Horizon feature)
tryCatch({
  semantic_result <- sf_query("SHOW SEMANTIC MODELS IN ${database}.${schema}")
  cat("Semantic models query returned ", nrow(semantic_result), " rows\\n")

  if (nrow(semantic_result) > 0) {
    for (i in 1:nrow(semantic_result)) {
      all_items[[length(all_items) + 1]] <- list(
        name = as.character(semantic_result$name[i]),
        type = "SEMANTIC_MODEL",
        rows = 0
      )
    }
  }
}, error = function(e) {
  cat("Semantic models query error (may not be available): ", e$message, "\\n")
})

# 7b. Try to get cortex analyst semantic models (alternative command)
tryCatch({
  semantic_views_result <- sf_query("SHOW CORTEX ANALYST SEMANTIC MODELS IN ${database}.${schema}")
  cat("Cortex analyst semantic models query returned ", nrow(semantic_views_result), " rows\\n")

  if (nrow(semantic_views_result) > 0) {
    for (i in 1:nrow(semantic_views_result)) {
      item_name <- as.character(semantic_views_result$name[i])
      # Check if not already added
      existing_names <- sapply(all_items, function(x) x$name)
      if (!(item_name %in% existing_names)) {
        all_items[[length(all_items) + 1]] <- list(
          name = item_name,
          type = "SEMANTIC_MODEL",
          rows = 0
        )
      }
    }
  }
}, error = function(e) {
  cat("Cortex analyst semantic models query error (may not be available): ", e$message, "\\n")
})

# 8. Try alternate query for objects using information_schema
# This catches any objects that might be missed by SHOW commands
tryCatch({
  info_query <- paste0(
    "SELECT table_name, table_type, row_count ",
    "FROM ${database}.information_schema.tables ",
    "WHERE table_schema = '${schema}' ",
    "ORDER BY table_name"
  )
  cat("Executing info_schema query: ", info_query, "\\n")
  info_result <- sf_query(info_query)
  cat("Information schema query returned ", nrow(info_result), " rows\\n")

  # Debug: print what table types we found
  if (nrow(info_result) > 0) {
    unique_types <- unique(info_result$table_type)
    cat("Table types found in info_schema: ", paste(unique_types, collapse=", "), "\\n")
  }

  if (nrow(info_result) > 0) {
    # Only add items not already in the list
    existing_names <- sapply(all_items, function(x) x$name)

    for (i in 1:nrow(info_result)) {
      item_name <- as.character(info_result$table_name[i])
      if (!(item_name %in% existing_names)) {
        item_type <- toupper(as.character(info_result$table_type[i]))

        # Normalize type names
        if (item_type == "BASE TABLE") {
          item_type <- "TABLE"
        } else if (item_type == "SEMANTIC MODEL" || item_type == "SEMANTIC_MODEL") {
          item_type <- "SEMANTIC_MODEL"
        } else if (grepl("SEMANTIC", item_type, ignore.case = TRUE)) {
          # Catch any semantic-related types
          item_type <- "SEMANTIC_MODEL"
          cat("Found semantic type: ", as.character(info_result$table_type[i]), " -> SEMANTIC_MODEL\\n")
        }

        all_items[[length(all_items) + 1]] <- list(
          name = item_name,
          type = item_type,
          rows = ifelse(is.na(info_result$row_count[i]), 0, as.numeric(info_result$row_count[i]))
        )
        cat("Added from info_schema: ", item_name, " (", item_type, ")\\n")
      }
    }
  }
}, error = function(e) {
  cat("Information schema query error: ", e$message, "\\n")
})

# 9. Final safety net: Try SHOW OBJECTS to catch everything
tryCatch({
  objects_result <- sf_query("SHOW OBJECTS IN ${database}.${schema}")
  cat("Show objects query returned ", nrow(objects_result), " rows\\n")

  if (nrow(objects_result) > 0) {
    # Filter to only table-like objects (not procedures, functions, etc.)
    table_like_types <- c("TABLE", "VIEW", "MATERIALIZED VIEW", "EXTERNAL TABLE",
                          "DYNAMIC TABLE", "STREAM", "SEMANTIC MODEL")

    existing_names <- sapply(all_items, function(x) x$name)

    for (i in 1:nrow(objects_result)) {
      item_name <- as.character(objects_result$name[i])
      # Get the kind column which contains the object type
      if ("kind" %in% names(objects_result)) {
        item_kind <- toupper(as.character(objects_result$kind[i]))
      } else {
        next  # Skip if no kind column
      }

      # Only process table-like objects we haven't already added
      if (item_kind %in% table_like_types && !(item_name %in% existing_names)) {
        # Normalize the type
        normalized_type <- gsub(" ", "_", item_kind)

        all_items[[length(all_items) + 1]] <- list(
          name = item_name,
          type = normalized_type,
          rows = 0
        )
        cat("Added from SHOW OBJECTS: ", item_name, " (", normalized_type, ")\\n")
      }
    }
  }
}, error = function(e) {
  cat("Show objects query error: ", e$message, "\\n")
})

cat("\\nTotal items found: ", length(all_items), "\\n")
if (length(all_items) > 0) {
  cat("Items by type:\\n")
  types <- sapply(all_items, function(x) x$type)
  type_counts <- table(types)
  for (t in names(type_counts)) {
    cat("  ", t, ": ", type_counts[t], "\\n")
  }
}
cat("\\n")
cat(toJSON(all_items, auto_unbox = TRUE))
`,
          autoFormatTabular: false
        })
      });

      const result = await response.json();
      console.log('========================================');
      console.log(`Loading objects for ${database}.${schema}`);
      console.log('========================================');

      // Log the full R output for debugging
      if (result.output) {
        console.log('R Output:');
        console.log(result.output);
      }

      if (result.error) {
        console.error('R Errors:', result.error);
      }

      // Extract JSON from output - find the JSON array
      let items = [];
      if (result.output) {
        // Look for JSON array pattern
        const jsonMatch = result.output.match(/\[[\s\S]*?\](?=\s*$|\s*\n)/);

        if (jsonMatch) {
          console.log('Tables JSON found: Yes');
          try {
            items = JSON.parse(jsonMatch[0]);
            console.log(`Successfully parsed ${items.length} items`);
            console.log('Items:', items);

            // Log type breakdown
            const typeCounts = {};
            items.forEach(item => {
              typeCounts[item.type] = (typeCounts[item.type] || 0) + 1;
            });
            console.log('Type breakdown:', typeCounts);
          } catch (e) {
            console.error('JSON parse error:', e);
            return [];
          }
        } else {
          console.log('Tables JSON found: No');
          console.log('Output does not contain JSON array');
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
      setExpandedNodes(newExpanded);
    } else {
      // Expand
      console.log('Expanding node:', node.id);
      newExpanded.add(node.id);
      setExpandedNodes(newExpanded);

      // Load children if not loaded
      if (!node.isLoaded) {
        console.log('Loading children for', node.type);
        setLoadingNodeId(node.id);

        try {
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
        } finally {
          setLoadingNodeId(null);
        }
      } else {
        console.log('Node already loaded, just expanding');
      }
    }
  };

  const toggleSelection = (item, event) => {
    // Allow selection of all queryable objects
    const selectableTypes = ['table', 'view', 'materialized_view', 'external_table', 'dynamic_table', 'stream', 'semantic_model'];
    if (!selectableTypes.includes(item.type)) return;

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
    const isNodeLoading = loadingNodeId === node.id;
    const selectableTypes = ['table', 'view', 'materialized_view', 'external_table', 'dynamic_table', 'stream', 'semantic_model'];
    const isSelectable = selectableTypes.includes(node.type);

    let icon;
    if (node.type === 'database') {
      icon = '/sf_db.png';
    } else if (node.type === 'schema') {
      icon = '/sf_schema.png';
    } else if (node.type === 'table' || node.type === 'external_table' || node.type === 'dynamic_table') {
      icon = '/sf_table.png';
    } else if (node.type === 'view' || node.type === 'materialized_view' || node.type === 'stream' || node.type === 'semantic_model') {
      icon = '/sf_view.png';
    } else {
      // Default icon for unknown types
      icon = '/sf_table.png';
    }

    const hasCaratSlot = node.type === 'database' || node.type === 'schema';
    const carat = hasCaratSlot && !isNodeLoading
      ? (isExpanded ? '/carat_open.png' : '/carat_closed.png')
      : null;

    return (
      <div key={node.id}>
        <div
          className={`flex items-center py-1 px-2 cursor-pointer ${
            isSelected ? 'bg-[#3686c1] text-white' : 'hover:bg-gray-100'
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
          {isNodeLoading ? (
            <img
              src="/snowflake-bug-color-rgb.svg"
              alt="Loading..."
              className="w-3 h-3 mr-2"
              style={{
                animation: 'snowflake-pulse 1.5s ease-in-out infinite'
              }}
            />
          ) : carat ? (
            <img
              src={carat}
              alt=""
              className="w-3 h-3 mr-2"
              onClick={(e) => {
                e.stopPropagation();
                toggleNode(node);
              }}
            />
          ) : (
            <span className="w-3 mr-2"></span>
          )}

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
      <style>{`
        @keyframes snowflake-pulse {
          0%, 100% {
            transform: scale(0.5);
            opacity: 0.6;
          }
          50% {
            transform: scale(1.5);
            opacity: 1;
          }
        }
      `}</style>
      <div className="bg-[#edeff0] rounded-lg shadow-xl w-[960px] h-[720px] flex flex-col">
        {/* Header */}
        <div className="p-4 flex items-center justify-between flex-shrink-0">
          <img src="/snowflake-logo-color-rgb.svg" alt="Snowflake" className="h-8" />
          <div className="relative" style={{ width: '240px' }}>
            <img
              src="/search.svg"
              alt=""
              className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 pointer-events-none"
            />
            <input
              type="text"
              placeholder="Search databases..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-9 pr-9 py-1.5 border border-gray-300 rounded-full text-sm focus:outline-none focus:ring-2 focus:ring-[#3686c1] focus:border-transparent"
            />
            {searchTerm && (
              <img
                src="/clear-search.svg"
                alt="Clear search"
                className="absolute right-3 top-1/2 transform -translate-y-1/2 w-5 h-5 cursor-pointer"
                onClick={() => setSearchTerm('')}
              />
            )}
          </div>
        </div>

        {/* Tree View */}
        <div className="flex-1 min-h-0 px-4 py-1.5 flex flex-col">
          <div className="bg-white border border-gray-300 rounded-md flex-1 min-h-0 overflow-auto relative">
            {isLoading && (
              <div className="absolute inset-0 flex items-center justify-center">
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

            {!isLoading && !error && treeData.length > 0 && (() => {
              const filteredData = searchTerm
                ? treeData.filter(node =>
                    node.name.toLowerCase().includes(searchTerm.toLowerCase())
                  )
                : treeData;

              return filteredData.length > 0 ? (
                <>
                  {filteredData.map(node => renderNode(node))}
                </>
              ) : (
                <div className="text-gray-500 text-center p-4">
                  No databases match "{searchTerm}"
                </div>
              );
            })()}

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
              className="w-24 px-4 py-2 bg-white border border-gray-300 rounded-md hover:bg-gray-100"
            >
              Cancel
            </button>
            <button
              onClick={handleLoad}
              disabled={selectedItems.length === 0}
              className="w-24 px-4 py-2 bg-[#3686c1] text-white rounded-md hover:bg-[#2a6a9a] disabled:opacity-50 disabled:cursor-not-allowed"
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
