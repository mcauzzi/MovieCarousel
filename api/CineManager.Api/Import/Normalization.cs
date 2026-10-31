using System.Globalization;
using System.Text;
using System.Text.Json.Nodes;

namespace CineManager.Api.Import;

public static class TitleNormalizer
{
    /// <summary>
    /// Titolo normalizzato per l'abbinamento (§8, passo 3; §7 per i duplicati): minuscole, senza
    /// accenti, punteggiatura sostituita da spazi, spazi compressi. "L'Âge d'or!" → "l age d or".
    /// </summary>
    public static string Normalize(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return "";
        var decomposed = title.Normalize(NormalizationForm.FormKD);
        var sb = new StringBuilder(decomposed.Length);
        var pendingSpace = false;
        foreach (var ch in decomposed)
        {
            var cat = CharUnicodeInfo.GetUnicodeCategory(ch);
            if (cat is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark)
                continue;
            if (char.IsLetterOrDigit(ch))
            {
                if (pendingSpace && sb.Length > 0) sb.Append(' ');
                pendingSpace = false;
                sb.Append(char.ToLowerInvariant(ch));
            }
            else pendingSpace = true;
        }
        // Lettere senza scomposizione Unicode.
        return sb.Replace('ß', 's').Replace('ø', 'o').Replace('æ', 'a').Replace('œ', 'o').Replace('ł', 'l').ToString();
    }

    /// <summary>Chiave titolo + anno; null se il titolo è vuoto.</summary>
    public static string? Key(JsonObject data) =>
        Normalize(AsString(data["title"])) is { Length: > 0 } title ? title + "|" + YearOf(data) : null;

    internal static string YearOf(JsonObject data)
    {
        var y = data["year"];
        if (y is JsonValue v)
        {
            // Qualsiasi numero JSON (int, long, double: i nodi creati in memoria non convertono tra tipi).
            if (v.GetValueKind() == System.Text.Json.JsonValueKind.Number &&
                double.TryParse(v.ToJsonString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d))
                return ((int)d).ToString(CultureInfo.InvariantCulture);
            if (v.TryGetValue<string>(out var s) && int.TryParse(s.Trim(), NumberStyles.Integer, CultureInfo.InvariantCulture, out var p))
                return p.ToString(CultureInfo.InvariantCulture);
        }
        return "";
    }

    internal static string? AsString(JsonNode? node) => node switch
    {
        JsonValue v when v.TryGetValue<string>(out var s) => s,
        JsonValue v => v.ToJsonString(),
        _ => null,
    };
}

public static class EanNormalizer
{
    /// <summary>
    /// Codice a barre normalizzato: solo cifre; un UPC-A (12 cifre) riceve lo zero davanti e
    /// diventa EAN-13. Null se non restano cifre. Le altre lunghezze (EAN-8…) restano come sono.
    /// </summary>
    public static string? Normalize(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var digits = new string(raw.Where(char.IsAsciiDigit).ToArray());
        if (digits.Length == 0) return null;
        return digits.Length == 12 ? "0" + digits : digits;
    }
}
