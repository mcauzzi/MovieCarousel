using System.Globalization;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using CineManager.Api.Data;

namespace CineManager.Api.Movies;

/// <summary>
/// CSV per l'import in Tellico (§9): intestazioni = titoli dei campi, UTF-8 senza BOM,
/// separatore <c>,</c>, quoting RFC 4180 (righe CRLF); valori multipli separati da <c>; </c>,
/// tabelle come <c>col::col; col::col</c>, bool <c>true</c>/vuoto, date <c>AAAA-MM-GG</c>.
/// Esclusi i campi <c>image</c>, <c>dependent</c> e quelli di sistema (id, cdate, mdate).
/// Nessun escape anti "formula injection": corromperebbe i dati in Tellico.
/// </summary>
public static class CsvExporter
{
    public sealed record Row(string? Ean, JsonObject Data);

    public static string Write(IReadOnlyList<CollectionField> fields, string barcodeField, IEnumerable<Row> rows)
    {
        var columns = fields
            .Where(f => f.Type is not (FieldTypes.Image or FieldTypes.Dependent) && !FieldCatalog.SystemFields.Contains(f.Name))
            .OrderBy(f => f.Ordinal).ThenBy(f => f.Name, StringComparer.Ordinal)
            .ToList();
        // La colonna del codice a barre c'è sempre (serve all'abbinamento al re-import, §8).
        if (!columns.Any(f => f.Name == barcodeField))
            columns.Add(new CollectionField { Name = barcodeField, Title = FieldCatalog.BarcodeFallbackTitle, Type = FieldTypes.Line });

        var sb = new StringBuilder();
        AppendLine(sb, columns.Select(c => c.Title));
        foreach (var row in rows)
            AppendLine(sb, columns.Select(c => c.Name == barcodeField
                ? row.Ean ?? Format(c, row.Data[c.Name])
                : Format(c, row.Data[c.Name])));
        return sb.ToString();
    }

    /// <summary>Valore di una cella secondo il tipo del campo.</summary>
    public static string Format(CollectionField field, JsonNode? node)
    {
        if (node is null) return "";
        if (field.Type == FieldTypes.Bool) return IsTrue(node) ? "true" : "";
        if (node is JsonArray arr)
            return string.Join("; ", arr.Select(item => item switch
            {
                JsonObject o when o.ContainsKey("actor") =>
                    Cell(o["actor"]) + (Cell(o["role"]) is { Length: > 0 } role ? "::" + role : ""),
                JsonObject o => string.Join("::", o.Select(p => Cell(p.Value))),
                JsonArray cols => string.Join("::", cols.Select(Cell)).TrimEnd(':'),
                _ => Cell(item),
            }).Where(s => s.Length > 0));
        if (field.Type == FieldTypes.Date) return NormalizeDate(Cell(node));
        return Cell(node);
    }

    private static bool IsTrue(JsonNode node) => node is JsonValue v &&
        (v.GetValueKind() == JsonValueKind.True || (v.TryGetValue<string>(out var s) && s.Trim() is "true" or "1"));

    private static string Cell(JsonNode? node) => node switch
    {
        null => "",
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        JsonValue v when v.GetValueKind() == JsonValueKind.Number =>
            v.TryGetValue<long>(out var l) ? l.ToString(CultureInfo.InvariantCulture)
                                           : v.GetValue<double>().ToString(CultureInfo.InvariantCulture),
        JsonValue v when v.GetValueKind() == JsonValueKind.True => "true",
        JsonValue v when v.GetValueKind() == JsonValueKind.False => "",
        _ => node.ToJsonString(),
    };

    /// <summary>Date già ISO restano come sono; <c>AAAAMMGG</c> diventa <c>AAAA-MM-GG</c>.</summary>
    private static string NormalizeDate(string s)
    {
        s = s.Trim();
        if (s.Length == 8 && s.All(char.IsAsciiDigit)) return $"{s[..4]}-{s[4..6]}-{s[6..]}";
        return s;
    }

    private static void AppendLine(StringBuilder sb, IEnumerable<string> cells) =>
        sb.AppendJoin(',', cells.Select(Quote)).Append("\r\n");

    /// <summary>Quoting RFC 4180: tra virgolette se contiene virgola, virgolette, a capo o spazi ai bordi.</summary>
    public static string Quote(string value)
    {
        var needs = value.Length > 0 && (value.IndexOfAny([',', '"', '\r', '\n']) >= 0 ||
                                         char.IsWhiteSpace(value[0]) || char.IsWhiteSpace(value[^1]));
        return needs ? "\"" + value.Replace("\"", "\"\"") + "\"" : value;
    }
}
