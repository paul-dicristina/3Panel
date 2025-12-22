# Example: Proper Snowflake connection in 3Panel
# This approach creates a fresh connection each time and cleans it up

library(DBI)
library(odbc)

# Create connection (do this at the START of each code block)
con <- dbConnect(
  odbc::odbc(),
  Driver = "SnowflakeDSIIDriver",  # or your driver name
  Server = "your-account.snowflakecomputing.com",
  UID = "your_username",
  PWD = "your_password",  # Consider using environment variables
  Database = "your_database",
  Warehouse = "your_warehouse",
  Schema = "your_schema"
)

# Now you can use the connection
databases <- dbGetQuery(con, "SHOW DATABASES")
print(databases)

# IMPORTANT: Close the connection when done
dbDisconnect(con)

# DO NOT rely on the connection persisting to the next code block!
