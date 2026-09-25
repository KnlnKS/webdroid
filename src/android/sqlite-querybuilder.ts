import { JObj, rt } from "../jvm/runtime";
import { vcall } from "../jvm/natives/jlang";
import { toJsArray } from "../jvm/natives/jutil";
import { csText } from "../jvm/natives/jchars";
import { buildQuery, deleteRows, runQuery, sqlQuoted, updateRows, type JContentValues, type JSQLiteDatabase } from "./sqlite";

class JSQLiteQueryBuilder extends JObj {
  tables: string | null = null;
  projectionMap: unknown = null;
  where = "";
  distinct = false;
}
async function projectionColumns(builder: JSQLiteQueryBuilder, requested: string[] | null): Promise<string[] | null> {
  const map = builder.projectionMap;
  if (!map) return requested;
  const columns = requested?.length ? requested : (await toJsArray(await vcall(map, "keySet", "()Ljava/util/Set;")))
    .filter(key => key !== "_count").map(String);
  return Promise.all(columns.map(async name => {
    const mapped = await vcall(map, "get", "(Ljava/lang/Object;)Ljava/lang/Object;", name);
    if (mapped != null) return String(mapped);
    if (/\sAS\s/i.test(name)) return name;
    throw rt.mkThrowable("java/lang/IllegalArgumentException", "Invalid column " + name);
  }));
}
function builderWhere(builder: JSQLiteQueryBuilder, selection: string | null): string | null {
  if (!builder.where) return selection;
  return selection ? `(${builder.where}) AND (${selection})` : `(${builder.where})`;
}
function builderEditTable(builder: JSQLiteQueryBuilder): string {
  const tables = builder.tables;
  if (tables === null) return rt.npe();
  return tables.split(/[\s,]/, 1)[0];
}
async function queryBuilder(builder: JSQLiteQueryBuilder, db: JSQLiteDatabase, cols: string[] | null, selection: string | null,
  args: unknown[] | null, groupBy: string | null, having: string | null, orderBy: string | null, limit: string | null) {
  if (builder.tables === null) return null;
  const sql = buildQuery({ table: builder.tables, cols: await projectionColumns(builder, cols),
    sel: builderWhere(builder, selection), groupBy, having, orderBy, limit, distinct: builder.distinct });
  return runQuery(db, sql, args);
}
rt.register({
  name: "android/database/sqlite/SQLiteQueryBuilder", ctor: JSQLiteQueryBuilder,
  methods: {
    "<init>()V": function () {},
    "setTables(Ljava/lang/String;)V": function (this: JSQLiteQueryBuilder, tables: string | null) { this.tables = tables; },
    "getTables()Ljava/lang/String;": function (this: JSQLiteQueryBuilder) { return this.tables; },
    "setProjectionMap(Ljava/util/Map;)V": function (this: JSQLiteQueryBuilder, map: unknown) { this.projectionMap = map; },
    "getProjectionMap()Ljava/util/Map;": function (this: JSQLiteQueryBuilder) { return this.projectionMap; },
    "setDistinct(Z)V": function (this: JSQLiteQueryBuilder, distinct: number) { this.distinct = !!distinct; },
    "isDistinct()Z": function (this: JSQLiteQueryBuilder) { return +this.distinct; },
    "appendWhere(Ljava/lang/CharSequence;)V": async function (this: JSQLiteQueryBuilder, where: unknown) { this.where += await csText(where); },
    "appendWhereStandalone(Ljava/lang/CharSequence;)V": async function (this: JSQLiteQueryBuilder, where: unknown) {
      if (this.where) this.where += " AND ";
      this.where += `(${await csText(where)})`;
    },
    "appendWhereEscapeString(Ljava/lang/String;)V": function (this: JSQLiteQueryBuilder, where: string) {
      this.where += sqlQuoted(where);
    },
    "query(Landroid/database/sqlite/SQLiteDatabase;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
      function (this: JSQLiteQueryBuilder, db: JSQLiteDatabase, cols: string[] | null, selection: string | null, args: unknown[] | null, groupBy: string | null, having: string | null, orderBy: string | null) {
        return queryBuilder(this, db, cols, selection, args, groupBy, having, orderBy, null);
      },
    "query(Landroid/database/sqlite/SQLiteDatabase;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;":
      function (this: JSQLiteQueryBuilder, db: JSQLiteDatabase, cols: string[] | null, selection: string | null, args: unknown[] | null, groupBy: string | null, having: string | null, orderBy: string | null, limit: string | null) {
        return queryBuilder(this, db, cols, selection, args, groupBy, having, orderBy, limit);
      },
    "update(Landroid/database/sqlite/SQLiteDatabase;Landroid/content/ContentValues;Ljava/lang/String;[Ljava/lang/String;)I":
      function (this: JSQLiteQueryBuilder, db: JSQLiteDatabase, values: JContentValues, selection: string | null, args: unknown[] | null) {
        if (!db || !values) rt.npe();
        if (!values.data.m.size) throw rt.mkThrowable("java/lang/IllegalArgumentException", "Empty values");
        return updateRows(db, builderEditTable(this), values, builderWhere(this, selection), args);
      },
    "delete(Landroid/database/sqlite/SQLiteDatabase;Ljava/lang/String;[Ljava/lang/String;)I":
      function (this: JSQLiteQueryBuilder, db: JSQLiteDatabase, selection: string | null, args: unknown[] | null) {
        if (!db) rt.npe();
        return deleteRows(db, builderEditTable(this), builderWhere(this, selection), args);
      },
  },
});
