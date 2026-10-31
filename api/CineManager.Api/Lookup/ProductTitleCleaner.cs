using System.Globalization;
using System.Text.RegularExpressions;

namespace CineManager.Api.Lookup;

/// <summary>
/// Pulizia del nome prodotto dei database di codici a barre (§7, passo 2): via formato e
/// confezione (DVD, Blu-ray, 4K, Steelbook, Edizione…, Import…), contenuto tra parentesi;
/// l'anno, se c'è, diventa un filtro per la ricerca.
/// </summary>
public static partial class ProductTitleCleaner
{
    public sealed record Cleaned(string Title, int? Year);

    [GeneratedRegex(@"[\(\[\{]([^\)\]\}]*)[\)\]\}]")]
    private static partial Regex Brackets();

    [GeneratedRegex(@"^\s*((?:19|20)\d{2})\s*$")]
    private static partial Regex BareYear();

    // Parole di formato e confezione (anche attaccate da trattini o barre).
    [GeneratedRegex(@"(?ix)
        \b(?:
            blu[\s-]?ray(?:\s*3d)? | bluray | bd | dvd(?:[\s-]?video)? | hd[\s-]?dvd | 4k(?:\s*ultra\s*hd)? | ultra\s*hd | uhd | hd |
            steel\s?book | digipa(?:k|ck) | slip\s?case | slip\s?cover | o-?card | cofanetto | box\s*set |
            import(?:\s+\w+)? | versione\s+(?:italiana|integrale|originale) |
            region(?:e)?\s*[0-9ab] | zona\s*[0-9] | pal | ntsc |
            \d+\s*(?:dischi|disc(?:s|hi)?|dvds?) | (?:\d+[\s-])?disc |
            (?:special|limited|collector'?s?|deluxe|anniversary|ultimate|extended|definitive|remastered|restaurata|speciale|limitata|da\s+collezione)
                (?:\s+(?:edition|edizione))? |
            edition | edizione(?:\s+\w+)? | ed\.(?:\s+\w+)? |
            \+\s*digital | digital\s*copy | widescreen | full\s*screen | 3d
        )\b\.?")]
    private static partial Regex FormatWords();

    [GeneratedRegex(@"\s+((?:19|20)\d{2})\s*$")]
    private static partial Regex TrailingYear();

    [GeneratedRegex(@"\s{2,}")]
    private static partial Regex Spaces();

    [GeneratedRegex(@"\s*[-–—:|/,;+]\s*(?=[-–—:|/,;+]|$)")]
    private static partial Regex DanglingSeparators();

    public static Cleaned Clean(string? productName, int? currentYear = null)
    {
        if (string.IsNullOrWhiteSpace(productName)) return new("", null);
        var maxYear = (currentYear ?? DateTime.UtcNow.Year) + 1;
        int? year = null;
        bool Plausible(string s, out int y) =>
            int.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out y) && y >= 1880 && y <= maxYear;

        // Anno tra parentesi, poi via tutto il contenuto tra parentesi.
        foreach (Match m in Brackets().Matches(productName))
        {
            var inner = BareYear().Match(m.Groups[1].Value);
            if (year is null && inner.Success && Plausible(inner.Groups[1].Value, out var y)) year = y;
        }
        var s = Brackets().Replace(productName, " ");
        s = FormatWords().Replace(s, " ");
        s = Spaces().Replace(s, " ").Trim();

        // Anno in coda, solo se resta dell'altro testo (es. "Ritorno al futuro 1985", non "1917").
        var trailing = TrailingYear().Match(s);
        if (trailing.Success && Plausible(trailing.Groups[1].Value, out var ty) && trailing.Index > 0)
        {
            year ??= ty;
            s = s[..trailing.Index];
        }

        for (var i = 0; i < 3; i++) s = DanglingSeparators().Replace(s, "");
        s = Spaces().Replace(s, " ").Trim().Trim('-', '–', '—', ':', '|', '/', ',', ';', '+', '.', ' ');
        return new(s, year);
    }
}
