// JDBC related utilities.
package com.lynxanalytics.biggraph.graph_util

import com.lynxanalytics.biggraph.graph_api.RuntimeContext
import com.lynxanalytics.biggraph.{ bigGraphLogger => log }

import java.sql
import org.apache.spark.sql.DataFrame
import org.apache.spark.sql.SQLContext

object JDBCQuoting {
  private val SimpleIdentifier = "[a-zA-Z0-9_]+".r
  def quoteIdentifier(s: String) = {
    s match {
      case SimpleIdentifier() => s
      case _ => '"' + s.replaceAll("\"", "\"\"") + '"'
    }
  }
}

object JDBCUtil {
  // Reads a table from JDBC, partitioned by a keyColumn. This is a wrapper around Spark's
  // DataFrameReader.jdbc() but it also takes care of deciding the optimal number of partitions and
  // the partitioning strategy depending on keyColumn and predicates.
  def read(context: SQLContext, url: String, table: String, keyColumn: String, predicates: List[String]): DataFrame = {
    assert(url.startsWith("jdbc:"), "JDBC URL has to start with jdbc:")
    assert(keyColumn.isEmpty || predicates.isEmpty, "Cannot define both keyColumn and predicates.")
    val props = new java.util.Properties
    if (keyColumn.isEmpty) {
      if (predicates.isEmpty) {
        // Inefficiently read into a single partition.
        context.read.jdbc(url, table, props)
      } else {
        context.read.jdbc(url, table, predicates.toArray, props)
      }
    } else {
      val stats = try TableStats(url, table, keyColumn)
      val numPartitions = RuntimeContext.partitionerForNRows(stats.count).numPartitions
      stats.keyType match {
        case KeyTypes.String =>
          context.read.jdbc(
            url,
            table,
            stringPartitionClauses(
              keyColumn,
              stats.minStringKey.get,
              stats.maxStringKey.get,
              numPartitions).toArray,
            props)
        case KeyTypes.Number =>
          context.read.jdbc(
            url,
            table,
            keyColumn,
            stats.minLongKey.get,
            stats.maxLongKey.get,
            numPartitions,
            props)
      }
    }
  }

  val stringPrefixLength =
    LoggedEnvironment.envOrElse("KITE_JDBC_STRING_PREFIX_LENGTH", "10").toInt

  // Creates a list of numPartitions conditions for WHERE clauses.
  // It partitions the range between minKey and maxKey by the alphabet.
  def stringPartitionClauses(
    keyColumn: String, minKey: String, maxKey: String, numPartitions: Int): Iterable[String] = {
    assert(minKey < maxKey, s"The database thinks $minKey < $maxKey.")
    // We assume strings are mostly made up of the following characters.
    val characters = (('0' to '9') ++ ('A' to 'Z') ++ ('a' to 'z') :+ ' ').sorted.mkString
    val base: Double = characters.length
    // Returns the index of the character in "characters" that is closest in ordering.
    def indexOf(c: Char) = {
      val i = characters.indexWhere(c <= _)
      if (i < 0) characters.length - 1 else i
    }
    // Converts the string to a number. If "characters" went from A to Z, AAAAAA would be 0.0 and
    // ZZZZZZ would be 0.999999.
    def toNumber(s: String) = {
      val values = s.map { c => 1.0 min (indexOf(c) / base) max 0.0 }
      values.zipWithIndex.map { case (v, i) => v * Math.pow(base, -i) }.sum
    }
    // Converts the number to a string. It returns a fixed-length string made up of characters in
    // "characters", but it should be quite close in lexicographic order to the original string.
    def toString(d: Double) = {
      val numbers = (0 until stringPrefixLength).map {
        i => (d % Math.pow(base, -i)) * Math.pow(base, i)
      }
      numbers.map { n => characters.charAt((n * base).toInt) }.mkString
    }
    // Now we can convert the start and end of the range to numbers, split it up to N equal slices
    // (partitions) and return the bounding strings for these intervals.
    val minKeyNumber = toNumber(minKey)
    val maxKeyNumber = toNumber(maxKey)
    assert(minKeyNumber < maxKeyNumber, s"Could not split the range between $minKey and $maxKey.")
    val keyRange = maxKeyNumber - minKeyNumber
    val bounds = (1 until numPartitions).map {
      i => '"' + toString(minKeyNumber + i * keyRange / numPartitions) + '"'
    }
    val order = ('"' + minKey + '"') +: bounds :+ ('"' + maxKey + '"')
    // Make sure we did not mess up.
    assert(order == order.sorted, s"Unexpected error while partitioning from $minKey to $maxKey.")
    // Make sure the same bound is not used twice. That would lead to duplicate data.
    assert(bounds.size == bounds.toSet.size,
      s"Could not split the range between $minKey and $maxKey into $numPartitions partitions.")
    if (bounds.isEmpty) {
      assert(numPartitions == 1, s"Unexpected partition count: $numPartitions")
      Array(null)
    } else {
      val k = keyColumn
      // Only upper bound for the first partition.
      s"$k < ${bounds.head}" +:
        bounds.zip(bounds.tail).map { case (a, b) => s"$a <= $k AND $k < $b" } :+
        // Only lower bound for the last partition.
        s"${bounds.last} <= $k"
    }
  }
}

object KeyTypes extends Enumeration {
  val String, Number = Value
}

case class TableStats(
  count: Long,
  keyType: KeyTypes.Value,
  minLongKey: Option[Long] = None, maxLongKey: Option[Long] = None,
  minStringKey: Option[String] = None, maxStringKey: Option[String] = None)
object TableStats {
  // Runs a query on the JDBC table to learn the TableStats values.
  def apply(url: String, table: String, keyColumn: String): TableStats = {
    val quotedTable = JDBCQuoting.quoteIdentifier(table)
    val quotedKey = JDBCQuoting.quoteIdentifier(keyColumn)
    val query =
      s"SELECT COUNT(*) as count, MIN($quotedKey) AS min, MAX($quotedKey) AS max FROM $quotedTable"
    log.info(s"Executing query: $query")
    val connection = sql.DriverManager.getConnection(url)
    try {
      val statement = connection.prepareStatement(query)
      try {
        val rs = statement.executeQuery()
        rs.next()
        try {
          val md = rs.getMetaData
          val count = rs.getLong("count")
          val keyType = md.getColumnType(2)
          keyType match {
            case sql.Types.VARCHAR =>
              new TableStats(
                count, KeyTypes.String, minStringKey = Some(rs.getString("min")),
                maxStringKey = Some(rs.getString("max")))
            case _ =>
              // Everything else we will try to treat as numbers and see what happens.
              new TableStats(
                count, KeyTypes.Number, minLongKey = Some(rs.getLong("min")),
                maxLongKey = Some(rs.getLong("max")))
          }
        } finally rs.close()
      } finally statement.close()
    } finally connection.close()
  }
}
