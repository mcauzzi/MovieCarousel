using System.Text.Json;
using System.Text.Json.Nodes;

namespace CineManager.Api.Infrastructure;

/// <summary>
/// Controlli sul JSON ricevuto prima di salvarlo in <c>jsonb</c>/<c>text</c>: Postgres rifiuta il
/// carattere NUL (<c>\u0000</c>, errore 22P05) e <see cref="JsonObject"/> non ammette chiavi
/// duplicate (ArgumentException). Entrambi diventerebbero 500: qui si traducono in un messaggio.
/// </summary>
public static class JsonSafety
{
    public const string NulMessage = "Il carattere NUL (\\u0000) non è ammesso.";

    public static bool HasNul(string? s) => s is not null && s.Contains('\0');

    /// <summary>Primo problema trovato (chiave duplicata o NUL), oppure null.</summary>
    public static string? Problem(JsonElement el)
    {
        switch (el.ValueKind)
        {
            case JsonValueKind.Object:
                var keys = new HashSet<string>(StringComparer.Ordinal);
                foreach (var p in el.EnumerateObject())
                {
                    if (HasNul(p.Name)) return NulMessage;
                    if (!keys.Add(p.Name)) return $"Chiave duplicata: '{p.Name}'.";
                    if (Problem(p.Value) is { } inner) return inner;
                }
                return null;
            case JsonValueKind.Array:
                foreach (var item in el.EnumerateArray())
                    if (Problem(item) is { } inner) return inner;
                return null;
            case JsonValueKind.String:
                return HasNul(el.GetString()) ? NulMessage : null;
            default:
                return null;
        }
    }

    /// <summary>Come <see cref="Problem(JsonElement)"/> per un nodo già letto.</summary>
    public static string? Problem(JsonNode? node)
    {
        try
        {
            switch (node)
            {
                case JsonObject o:
                    foreach (var (k, v) in o) // con chiavi duplicate l'enumerazione lancia ArgumentException
                    {
                        if (HasNul(k)) return NulMessage;
                        if (Problem(v) is { } inner) return inner;
                    }
                    return null;
                case JsonArray a:
                    foreach (var item in a)
                        if (Problem(item) is { } inner) return inner;
                    return null;
                case JsonValue v when v.GetValueKind() == JsonValueKind.String:
                    return HasNul(v.GetValue<string>()) ? NulMessage : null;
                default:
                    return null;
            }
        }
        catch (ArgumentException)
        {
            return "Chiave duplicata.";
        }
    }
}
