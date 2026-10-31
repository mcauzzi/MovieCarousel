using System.Globalization;
using System.Text.Json;
using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Import;
using CineManager.Api.Infrastructure;

namespace CineManager.Api.Movies;

/// <summary>
/// Validazione dei campi di un film inviati dall'app (<c>POST /api/app/movies</c>) o dal sito
/// (<c>PATCH /api/movies/{id}</c>) contro le definizioni di <c>collection_fields</c> (§5.1).
/// Produce i valori nello stesso formato del parser del sito: numeri come numeri, bool come
/// <c>"true"</c>, date <c>AAAA-MM-GG</c>, multipli come array, <c>cast</c> come <c>[{actor, role}]</c>,
/// altre tabelle come <c>string[][]</c>.
/// </summary>
public sealed class MovieValidator
{
    public const int MaxLine = 500;
    public const int MaxPara = 20_000;
    public const int MaxUrl = 2_000;
    public const int MaxItems = 100;
    public const int MaxTableRows = 200;
    public const int MaxTableColumns = 10;

    private readonly Dictionary<string, CollectionField> _fields;
    private readonly string _barcodeField;
    private readonly int _currentYear;

    public MovieValidator(IEnumerable<CollectionField> fields, string barcodeField, int currentYear)
    {
        _fields = fields.ToDictionary(f => f.Name, StringComparer.Ordinal);
        // Il titolo è sempre scrivibile, anche se la collezione non lo definisce.
        _fields.TryAdd("title", new CollectionField { Name = "title", Title = "Title", Type = FieldTypes.Line });
        _barcodeField = barcodeField;
        _currentYear = currentYear;
    }

    /// <summary>Esito: valori normalizzati (null = chiave da rimuovere), errori per campo, EAN se presente.</summary>
    public sealed record Result(Dictionary<string, JsonNode?> Values, Dictionary<string, string[]> Errors, string? Ean, bool HasEan)
    {
        public bool Ok => Errors.Count == 0;
    }

    /// <summary>
    /// <paramref name="allowBarcode"/>: il campo codice a barre dentro <c>movie</c> è ammesso
    /// (correzione dal sito) e restituito in <see cref="Result.Ean"/> normalizzato; altrimenti
    /// (app) l'EAN si invia solo nella proprietà <c>ean</c> di primo livello.
    /// </summary>
    public Result Validate(JsonObject input, bool allowBarcode)
    {
        var values = new Dictionary<string, JsonNode?>(StringComparer.Ordinal);
        var errors = new Dictionary<string, string[]>(StringComparer.Ordinal);
        string? ean = null;
        var hasEan = false;

        foreach (var (name, node) in input)
        {
            void Err(string msg) => errors[name] = [msg];

            if (name == _barcodeField)
            {
                if (!allowBarcode) { Err("Il codice a barre va inviato in 'ean'."); continue; }
                hasEan = true;
                if (IsEmptyValue(node)) { ean = null; continue; }
                var raw = node is JsonValue v && v.TryGetValue<string>(out var str) ? str
                        : node is JsonValue n && n.GetValueKind() == JsonValueKind.Number ? n.ToJsonString() : null;
                ean = EanNormalizer.Normalize(raw);
                if (ean is null || !IsValidEan(ean)) Err("Codice a barre non valido (8–14 cifre).");
                continue;
            }
            if (FieldCatalog.SystemFields.Contains(name) || name == FieldCatalog.CoverField)
            {
                Err("Campo impostato dal server: non scrivibile.");
                continue;
            }
            if (!_fields.TryGetValue(name, out var field))
            {
                Err("Campo sconosciuto.");
                continue;
            }
            if (field.Type is FieldTypes.Dependent or FieldTypes.Image)
            {
                Err("Campo non scrivibile.");
                continue;
            }

            if (IsEmptyValue(node)) { values[name] = null; continue; }
            var (value, error) = field.Type == FieldTypes.Table ? Table(field, node!) : MaybeMultiple(field, node!);
            if (error is not null) Err(error);
            else values[name] = value; // null = vuoto dopo la normalizzazione
        }
        return new Result(values, errors, ean, hasEan);
    }

    public static bool IsValidEan(string ean) => ean.Length is >= 8 and <= 14 && ean.All(char.IsAsciiDigit);

    /// <summary>Valore vuoto: null, testo vuoto o di soli spazi, elenco vuoto.</summary>
    public static bool IsEmptyValue(JsonNode? node) => node switch
    {
        null => true,
        JsonValue v when v.TryGetValue<string>(out var s) => string.IsNullOrWhiteSpace(s),
        JsonArray a => a.Count == 0,
        _ => false,
    };

    private (JsonNode? Value, string? Error) MaybeMultiple(CollectionField field, JsonNode node)
    {
        if (!field.Multiple)
        {
            if (node is JsonArray) return (null, "Il campo ammette un solo valore.");
            return Scalar(field, node);
        }
        var items = node is JsonArray arr ? arr : new JsonArray(node.DeepClone());
        if (items.Count > MaxItems) return (null, $"Al massimo {MaxItems} valori.");
        var result = new JsonArray();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in items)
        {
            if (IsEmptyValue(item)) continue;
            if (item is JsonArray or JsonObject) return (null, "Valori non validi.");
            var (v, err) = Scalar(field, item!);
            if (err is not null) return (null, err);
            if (v is not null && seen.Add(v.ToJsonString())) result.Add(v);
        }
        return (result.Count == 0 ? null : result, null);
    }

    private (JsonNode? Value, string? Error) Scalar(CollectionField field, JsonNode node)
    {
        if (node is not JsonValue v) return (null, "Valore non valido.");
        var kind = v.GetValueKind();
        string? str = kind == JsonValueKind.String ? v.GetValue<string>().Trim() : null;
        if (JsonSafety.HasNul(str)) return (null, JsonSafety.NulMessage); // Postgres jsonb non lo accetta

        switch (field.Type)
        {
            case FieldTypes.Number:
            case FieldTypes.Rating:
            {
                long n;
                if (kind == JsonValueKind.Number && v.TryGetValue<long>(out var l)) n = l;
                else if (str is not null && long.TryParse(str, NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var p)) n = p;
                else return (null, "Serve un numero intero.");
                var (min, max) = field.Type == FieldTypes.Rating ? (1L, 10L) : NumberRange(field.Name);
                if (n < min || n > max) return (null, $"Valore fuori intervallo ({min}–{max}).");
                return (JsonValue.Create(n), null);
            }
            case FieldTypes.Bool:
                if (kind == JsonValueKind.True || str is "true") return (JsonValue.Create("true"), null);
                if (kind == JsonValueKind.False || str is "false") return (null, null);
                return (null, "Serve true o false.");
            case FieldTypes.Date:
                if (str is null || !DateOnly.TryParseExact(str, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
                    return (null, "Serve una data AAAA-MM-GG.");
                return (JsonValue.Create(str), null);
            case FieldTypes.Url:
                if (str is null || str.Length > MaxUrl || !Uri.TryCreate(str, UriKind.Absolute, out var uri) ||
                    (uri.Scheme != Uri.UriSchemeHttp && uri.Scheme != Uri.UriSchemeHttps))
                    return (null, "Serve un URL http(s) assoluto.");
                return (JsonValue.Create(str), null);
            case FieldTypes.Choice:
            {
                if (str is null) return (null, "Serve un testo.");
                if (str.Length > MaxLine) return (null, $"Al massimo {MaxLine} caratteri.");
                if (field.Allowed is { Count: > 0 } allowed)
                {
                    var match = allowed.FirstOrDefault(a => a == str) ??
                                allowed.FirstOrDefault(a => string.Equals(a, str, StringComparison.OrdinalIgnoreCase));
                    if (match is null) return (null, "Valore non ammesso: " + string.Join(", ", allowed) + ".");
                    str = match;
                }
                return (JsonValue.Create(str), null);
            }
            case FieldTypes.Para:
                if (str is null) return (null, "Serve un testo.");
                if (str.Length > MaxPara) return (null, $"Al massimo {MaxPara} caratteri.");
                return (JsonValue.Create(str), null);
            default: // line e tipi sconosciuti
                if (str is null) return (null, "Serve un testo.");
                if (str.Length > MaxLine) return (null, $"Al massimo {MaxLine} caratteri.");
                if (str.Any(char.IsControl)) return (null, "Caratteri di controllo non ammessi.");
                return (JsonValue.Create(str), null);
        }
    }

    private (long Min, long Max) NumberRange(string name) => name switch
    {
        "year" => (1870, _currentYear + 5),
        "running-time" => (1, 2000),
        _ => (-1_000_000_000, 1_000_000_000),
    };

    /// <summary><c>cast</c>: <c>[{actor, role}]</c> (accetta anche <c>[[attore, ruolo]]</c>); altre tabelle: <c>string[][]</c>.</summary>
    private static (JsonNode? Value, string? Error) Table(CollectionField field, JsonNode node)
    {
        if (node is not JsonArray rows) return (null, "Serve un elenco di righe.");
        if (rows.Count > MaxTableRows) return (null, $"Al massimo {MaxTableRows} righe.");
        var isCast = field.Name == "cast";
        var result = new JsonArray();
        foreach (var row in rows)
        {
            List<string> cols;
            if (row is JsonObject o && isCast)
            {
                if (o.Any(p => p.Key is not ("actor" or "role"))) return (null, "Righe del cast: solo 'actor' e 'role'.");
                if (!TryCell(o["actor"], out var actor) || !TryCell(o["role"], out var role)) return (null, "Celle non valide.");
                cols = [actor, role];
            }
            else if (row is JsonArray cells)
            {
                if (cells.Count > MaxTableColumns) return (null, $"Al massimo {MaxTableColumns} colonne.");
                cols = [];
                foreach (var c in cells)
                {
                    if (!TryCell(c, out var s)) return (null, "Celle non valide.");
                    cols.Add(s);
                }
            }
            else return (null, isCast ? "Righe del cast: oggetti { actor, role }." : "Ogni riga è un elenco di celle.");

            if (cols.All(string.IsNullOrEmpty)) continue;
            if (isCast)
            {
                if (string.IsNullOrEmpty(cols[0])) return (null, "Ogni riga del cast richiede 'actor'.");
                result.Add(new JsonObject { ["actor"] = cols[0], ["role"] = cols.Count > 1 ? cols[1] : "" });
            }
            else result.Add(new JsonArray(cols.Select(c => (JsonNode?)JsonValue.Create(c)).ToArray()));
        }
        return (result.Count == 0 ? null : result, null);
    }

    private static bool TryCell(JsonNode? node, out string value)
    {
        value = "";
        if (node is null) return true;
        if (node is not JsonValue v || !v.TryGetValue<string>(out var s)) return false;
        value = s.Trim();
        return value.Length <= MaxLine && !value.Any(char.IsControl);
    }
}
