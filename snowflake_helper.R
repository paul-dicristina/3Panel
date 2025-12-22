# Snowflake Connection Helper for 3Panel
# Save this function to use across your code blocks

# Store connection parameters (these WILL persist in workspace)
SNOWFLAKE_CONFIG <- list(
  Driver = "SnowflakeDSIIDriver",
  Server = "your-account.snowflakecomputing.com",
  UID = "your_username",
  PWD = "your_password",  # Better: use Sys.getenv("SNOWFLAKE_PASSWORD")
  Database = "your_database",
  Warehouse = "your_warehouse",
  Schema = "your_schema"
)

# Helper function to get a fresh connection
get_snowflake_con <- function() {
  library(DBI)
  library(odbc)

  do.call(dbConnect, c(list(odbc::odbc()), SNOWFLAKE_CONFIG))
}

# Usage pattern for your code blocks:
# con <- get_snowflake_con()
# data <- dbGetQuery(con, "SELECT * FROM my_table")
# dbDisconnect(con)  # Always disconnect when done
