# Snowflake Connection Helper for 3Panel
# This file is automatically loaded with each R execution
#
# USAGE EXAMPLES FOR AI CODE GENERATION:
# =======================================
#
# CONNECTING (run once per conversation):
#   snowflake_connect()
#
# LISTING DATABASES:
#   sf_databases()
#
# SETTING CONTEXT (database/schema/warehouse):
#   sf_use(database = "DEMOS")                     - set current database
#   sf_use(database = "DEMOS", schema = "PUBLIC")  - set database and schema
#   sf_use(warehouse = "COMPUTE_WH")               - set warehouse
#   sf_use(database = "DEMOS", schema = "PUBLIC", warehouse = "COMPUTE_WH") - set all
#
# LISTING TABLES:
#   sf_tables()                                    - list tables in current database/schema
#   sf_tables(schema = "PUBLIC")                   - list tables in specific schema
#   sf_tables(database = "DEMOS", schema = "PUBLIC") - list tables in specific database.schema
#
# PREVIEWING TABLES (get first N rows):
#   sf_preview("CUSTOMERS")                        - preview table (10 rows)
#   sf_preview("PUBLIC.CUSTOMERS")                 - with schema qualifier
#   sf_preview("DEMOS.PUBLIC.CUSTOMERS")           - with full database.schema.table
#   sf_preview("CUSTOMERS", schema = "PUBLIC")     - using separate parameters
#   sf_preview("CUSTOMERS", database = "DEMOS", schema = "PUBLIC") - fully specified
#   sf_preview("CUSTOMERS", n = 25)                - get 25 rows instead of 10
#
# RUNNING QUERIES:
#   sf_query("SELECT * FROM CUSTOMERS LIMIT 100")
#   sf_query("SELECT COUNT(*) FROM ORDERS WHERE STATUS = 'COMPLETE'")
#
# NOTE: Always use dot notation (DATABASE.SCHEMA.TABLE) or separate parameters
#       Never pass schema/database as second positional argument to sf_preview()

# Function to save Snowflake credentials (run once per conversation)
# Robust connection with automatic format detection and retry logic
snowflake_connect <- function() {
  library(DBI)
  library(odbc)

  cat("🔗 Connecting to Snowflake...\n")

  # Base configuration
  base_config <- list(
    Driver = "Snowflake",
    uid = "paul.dicristina@posit.co",
    authenticator = "externalbrowser",
    client_session_keep_alive = "TRUE"
  )

  # Try multiple server formats in order of likelihood
  server_formats <- c(
    # Format 1: Account identifier without domain (most common for ODBC)
    "duloftf-posit-software-pbc-dev",
    # Format 2: Full hostname
    "duloftf-posit-software-pbc-dev.snowflakecomputing.com",
    # Format 3: Account identifier with port
    "duloftf-posit-software-pbc-dev:443"
  )

  conn <- NULL
  last_error <- NULL
  successful_format <- NULL

  # Try each server format
  for (i in seq_along(server_formats)) {
    server_format <- server_formats[i]
    cat(sprintf("  Attempt %d/%d: Trying server format '%s'...\n", i, length(server_formats), server_format))

    tryCatch({
      # Attempt connection with this format
      config <- c(base_config, list(server = server_format))

      # Add port if needed (for format 2)
      if (grepl("\\.snowflakecomputing\\.com$", server_format)) {
        config$port <- "443"
      }

      conn <- do.call(dbConnect, c(list(odbc::odbc()), config))

      # If we get here, connection succeeded!
      successful_format <- server_format
      cat(sprintf("  ✓ Connection successful with format: '%s'\n", server_format))
      break

    }, error = function(e) {
      last_error <- e
      err_msg <- conditionMessage(e)

      # Provide helpful diagnostics
      if (grepl("404|REST request failed", err_msg)) {
        cat(sprintf("  ✗ Format '%s' failed: Invalid server format (HTTP 404)\n", server_format))
      } else if (grepl("authentication", err_msg, ignore.case = TRUE)) {
        cat(sprintf("  ✗ Format '%s' failed: Authentication error\n", server_format))
      } else if (grepl("driver", err_msg, ignore.case = TRUE)) {
        cat(sprintf("  ✗ Format '%s' failed: Driver issue\n", server_format))
      } else {
        cat(sprintf("  ✗ Format '%s' failed: %s\n", server_format, substr(err_msg, 1, 80)))
      }
    })
  }

  # Check if we succeeded
  if (is.null(conn)) {
    cat("\n❌ All connection attempts failed!\n\n")
    cat("Troubleshooting tips:\n")
    cat("1. Verify Snowflake ODBC driver is installed:\n")
    cat("   - Run: odbcinst -q -d | grep -i snowflake\n")
    cat("2. Check your account identifier in Snowflake web console URL\n")
    cat("3. Ensure your account allows external browser authentication\n")
    cat("4. Check firewall/network settings\n\n")

    if (!is.null(last_error)) {
      cat("Last error details:\n")
      print(last_error)
    }

    stop("Unable to connect to Snowflake. Please check your configuration.")
  }

  # Test the connection and get current database info
  cat("\n📊 Retrieving account information...\n")
  current_db <- tryCatch({
    dbGetQuery(conn, "SELECT CURRENT_DATABASE() as db, CURRENT_SCHEMA() as schema, CURRENT_WAREHOUSE() as warehouse")
  }, error = function(e) {
    cat("Warning: Could not retrieve current context. Connection may still work.\n")
    data.frame(db = NA_character_, schema = NA_character_, warehouse = NA_character_, stringsAsFactors = FALSE)
  })

  # Store working connection info in workspace (this WILL persist)
  .snowflake_config <<- list(
    Driver = "Snowflake",
    server = successful_format,
    uid = "paul.dicristina@posit.co",
    authenticator = "externalbrowser",
    connected = TRUE,
    connected_at = Sys.time()
  )

  # Also add port if it was in the successful format
  if (grepl("\\.snowflakecomputing\\.com$", successful_format)) {
    .snowflake_config$port <<- "443"
  }

  # Store warehouse, database, and schema if they exist
  warehouse_set <- FALSE
  if (nrow(current_db) > 0 && length(current_db$warehouse) > 0 && !is.na(current_db$warehouse[1])) {
    .snowflake_config$warehouse <<- current_db$warehouse[1]
    warehouse_set <- TRUE
  }

  # If no warehouse is set, try to find and use one automatically
  if (!warehouse_set) {
    cat("\n⚠️  No default warehouse detected. Looking for available warehouses...\n")

    # Reconnect to query for warehouses
    temp_conn <- do.call(dbConnect, c(list(odbc::odbc()),
                         c(base_config, list(server = successful_format))))
    if (grepl("\\.snowflakecomputing\\.com$", successful_format)) {
      # Need to reconnect with port
      dbDisconnect(temp_conn)
      config_with_port <- c(base_config, list(server = successful_format, port = "443"))
      temp_conn <- do.call(dbConnect, c(list(odbc::odbc()), config_with_port))
    }

    warehouses <- tryCatch({
      dbGetQuery(temp_conn, "SHOW WAREHOUSES")
    }, error = function(e) {
      dbDisconnect(temp_conn)
      data.frame()
    })

    if (nrow(warehouses) > 0) {
      # Use the first available warehouse
      first_warehouse <- warehouses$name[1]
      cat(sprintf("  Found %d warehouse(s). Auto-selecting: %s\n", nrow(warehouses), first_warehouse))

      tryCatch({
        dbGetQuery(temp_conn, paste0("USE WAREHOUSE ", first_warehouse))
        .snowflake_config$warehouse <<- first_warehouse
        warehouse_set <- TRUE
      }, error = function(e) {
        cat("  Warning: Could not activate warehouse\n")
      })
    }

    dbDisconnect(temp_conn)
  }

  if (nrow(current_db) > 0 && length(current_db$db) > 0 && !is.na(current_db$db[1])) {
    .snowflake_config$database <<- current_db$db[1]
  }
  if (nrow(current_db) > 0 && length(current_db$schema) > 0 && !is.na(current_db$schema[1])) {
    .snowflake_config$schema <<- current_db$schema[1]
  }

  # Close the connection
  dbDisconnect(conn)

  cat("\n✅ Successfully connected to Snowflake!\n")
  cat("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
  cat(sprintf("Server:    %s\n", successful_format))
  cat(sprintf("User:      %s\n", base_config$uid))
  if (nrow(current_db) > 0 && length(current_db$db) > 0 && !is.na(current_db$db[1])) {
    cat(sprintf("Database:  %s\n", current_db$db[1]))
    cat(sprintf("Schema:    %s\n", current_db$schema[1]))
    cat(sprintf("Warehouse: %s\n", current_db$warehouse[1]))
  }
  cat("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
  cat("\n💡 You can now query Snowflake using:\n")
  cat("   • sf_query('SELECT ...')       - Run any SQL query\n")
  cat("   • sf_databases()               - List all databases\n")
  cat("   • sf_tables()                  - List tables\n")
  cat("   • sf_preview('TABLE_NAME')     - Preview a table\n")
  cat("   • sf_use(database='...')       - Change context\n\n")

  invisible(TRUE)
}

# Function to execute Snowflake queries (use after snowflake_connect)
sf_query <- function(sql, show_sql = FALSE) {
  # Check if credentials exist
  if (!exists(".snowflake_config") || !.snowflake_config$connected) {
    stop("❌ Not connected to Snowflake. Please run: snowflake_connect()")
  }

  library(DBI)
  library(odbc)

  if (show_sql) {
    cat("📝 SQL Query:\n")
    cat(sql, "\n\n")
  }

  # Build connection config from stored settings
  config <- list(
    Driver = .snowflake_config$Driver,
    server = .snowflake_config$server,
    uid = .snowflake_config$uid,
    authenticator = .snowflake_config$authenticator,
    client_session_keep_alive = "TRUE"
  )

  # Add port if it was stored
  if (!is.null(.snowflake_config$port)) {
    config$port <- .snowflake_config$port
  }

  # Add warehouse if it was stored (CRITICAL for query execution)
  if (!is.null(.snowflake_config$warehouse)) {
    config$warehouse <- .snowflake_config$warehouse
  }

  # Add database and schema if they were stored
  if (!is.null(.snowflake_config$database)) {
    config$database <- .snowflake_config$database
  }
  if (!is.null(.snowflake_config$schema)) {
    config$schema <- .snowflake_config$schema
  }

  # Create fresh connection with keep-alive
  conn <- tryCatch({
    do.call(dbConnect, c(list(odbc::odbc()), config))
  }, error = function(e) {
    err_msg <- conditionMessage(e)
    cat("\n❌ Failed to reconnect to Snowflake\n")
    cat("Error:", err_msg, "\n\n")

    if (grepl("404|REST request failed", err_msg)) {
      cat("💡 Tip: The server format may have changed. Try running snowflake_connect() again.\n")
    } else if (grepl("authentication", err_msg, ignore.case = TRUE)) {
      cat("💡 Tip: Authentication expired. Run snowflake_connect() to re-authenticate.\n")
    }

    stop("Connection failed: ", err_msg)
  })

  # Execute query with robust error handling
  result <- tryCatch({
    dbGetQuery(conn, sql)
  }, error = function(e) {
    # Make sure to disconnect even on error
    tryCatch(dbDisconnect(conn), error = function(e2) {})

    err_msg <- conditionMessage(e)
    cat("\n❌ Query execution failed\n")
    cat("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
    cat("SQL:", substr(sql, 1, 200), "\n")
    if (nchar(sql) > 200) cat("... (truncated)\n")
    cat("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n")
    cat("Error:", err_msg, "\n\n")

    # Provide helpful tips based on error type
    if (grepl("No active warehouse|warehouse", err_msg, ignore.case = TRUE)) {
      cat("💡 Tip: No warehouse is selected. Set one using:\n")
      cat("    sf_use(warehouse='COMPUTE_WH')  # or your warehouse name\n")
      cat("    Or list available warehouses with: sf_query('SHOW WAREHOUSES')\n")
    } else if (grepl("does not exist|unknown", err_msg, ignore.case = TRUE)) {
      cat("💡 Tip: Check that the database/schema/table exists and is spelled correctly.\n")
      cat("    Use sf_databases() and sf_tables() to explore available objects.\n")
    } else if (grepl("permission|authorized|access denied", err_msg, ignore.case = TRUE)) {
      cat("💡 Tip: You may not have permission to access this object.\n")
    } else if (grepl("syntax", err_msg, ignore.case = TRUE)) {
      cat("💡 Tip: SQL syntax error. Check your query syntax.\n")
    }

    stop("Query failed: ", err_msg, call. = FALSE)
  })

  # Clean up
  dbDisconnect(conn)

  return(result)
}

# Convenience function to list tables
sf_tables <- function(database = NULL, schema = NULL) {
  sql <- "SHOW TABLES"
  if (!is.null(database) && !is.null(schema)) {
    # Both database and schema specified
    sql <- paste0("SHOW TABLES IN ", database, ".", schema)
  } else if (!is.null(database)) {
    # Only database specified - show all tables in that database
    sql <- paste0("SHOW TABLES IN DATABASE ", database)
  } else if (!is.null(schema)) {
    # Only schema specified - show tables in that schema of current database
    sql <- paste0("SHOW TABLES IN SCHEMA ", schema)
  }
  # If neither specified, use "SHOW TABLES" which shows tables in current context
  sf_query(sql)
}

# Convenience function to list databases
sf_databases <- function() {
  sf_query("SHOW DATABASES")
}

# Function to set database/schema/warehouse context
sf_use <- function(database = NULL, schema = NULL, warehouse = NULL) {
  results <- list()

  if (!is.null(warehouse)) {
    result <- sf_query(paste0("USE WAREHOUSE ", warehouse))
    results$warehouse <- warehouse
    # Update stored config
    .snowflake_config$warehouse <<- warehouse
    cat("✓ Using warehouse:", warehouse, "\n")
  }

  if (!is.null(database)) {
    result <- sf_query(paste0("USE DATABASE ", database))
    results$database <- database
    # Update stored config
    .snowflake_config$database <<- database
    cat("✓ Using database:", database, "\n")
  }

  if (!is.null(schema)) {
    result <- sf_query(paste0("USE SCHEMA ", schema))
    results$schema <- schema
    # Update stored config
    .snowflake_config$schema <<- schema
    cat("✓ Using schema:", schema, "\n")
  }

  # Show current context
  context <- sf_query("SELECT CURRENT_DATABASE() as db, CURRENT_SCHEMA() as schema, CURRENT_WAREHOUSE() as warehouse")
  cat("\nCurrent context:\n")
  cat("  Database:", context$DB, "\n")
  cat("  Schema:", context$SCHEMA, "\n")
  cat("  Warehouse:", context$WAREHOUSE, "\n")

  invisible(results)
}

# Convenience function to preview a table
# Can be called multiple ways:
#   sf_preview("TABLE_NAME")                    - preview table in current database/schema
#   sf_preview("SCHEMA.TABLE_NAME")             - preview with schema qualifier
#   sf_preview("DATABASE.SCHEMA.TABLE_NAME")    - preview with full qualifier
#   sf_preview("TABLE_NAME", schema = "SCHEMA") - preview with separate schema
#   sf_preview("TABLE_NAME", database = "DB", schema = "SCHEMA") - preview with separate db/schema
#   sf_preview(..., n = 20)                     - change number of rows (default 10)
sf_preview <- function(table_name, database = NULL, schema = NULL, n = 10) {
  # Build fully qualified table name
  if (!is.null(database) && !is.null(schema)) {
    # Separate database and schema provided
    qualified_name <- paste0(database, ".", schema, ".", table_name)
  } else if (!is.null(schema)) {
    # Only schema provided
    qualified_name <- paste0(schema, ".", table_name)
  } else {
    # Use table_name as-is (may already be qualified)
    qualified_name <- table_name
  }

  sql <- paste0("SELECT * FROM ", qualified_name, " LIMIT ", n)
  sf_query(sql)
}

# Check if already connected (silent check)
if (exists(".snowflake_config") && .snowflake_config$connected) {
  cat("ℹ Snowflake helper loaded. Use sf_query() to run queries.\n")
}
