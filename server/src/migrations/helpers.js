'use strict';

/** ALTER TABLE ... ADD COLUMN, but only when the column is not there yet. Table/column names are code constants. */
function addColumnIfMissing(db, table, column, ddl) {
  const have = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!have.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

module.exports = { addColumnIfMissing };
