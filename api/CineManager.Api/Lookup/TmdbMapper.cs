using System.Text.Json;
using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Movies;

namespace CineManager.Api.Lookup;

/// <summary>
/// Bozza <c>Movie</c> da un film TMDb (§7, passo 3), nello stesso formato del parser del sito,
/// limitata ai campi che la collezione definisce (così l'app può reinviarla così com'è).
/// </summary>
public static class TmdbMapper
{
    public const int MaxCast = 10;

    /// <summary>Come <c>COUNTRY_NORMALIZE</c> di <c>src/parser.ts</c>, più i nomi usati da TMDb.</summary>
    private static readonly Dictionary<string, string> CountryNormalize = new(StringComparer.OrdinalIgnoreCase)
    {
        ["United States"] = "USA", ["United States of America"] = "USA",
        ["United Kingdom"] = "UK", ["Great Britain"] = "UK", ["England"] = "UK",
    };

    private static readonly Dictionary<string, string> CountryByIso = new(StringComparer.OrdinalIgnoreCase)
    {
        ["US"] = "USA", ["GB"] = "UK",
    };

    /// <summary>Come <c>LANG_NORMALIZE</c> di <c>src/parser.ts</c> (nomi inglesi → italiani).</summary>
    private static readonly Dictionary<string, string> LangNormalize = new(StringComparer.OrdinalIgnoreCase)
    {
        ["Inglese US"] = "Inglese", ["English"] = "Inglese", ["Inglese UK"] = "Inglese",
        ["Italian"] = "Italiano", ["Japanese"] = "Giapponese", ["French"] = "Francese", ["German"] = "Tedesco",
        ["Chinese"] = "Cinese", ["cn"] = "Cinese", ["Spanish"] = "Spagnolo", ["Russian"] = "Russo", ["Korean"] = "Coreano",
    };

    /// <summary>Nome italiano delle lingue da <c>iso_639_1</c> (TMDb non lo fornisce).</summary>
    private static readonly Dictionary<string, string> LangByIso = new(StringComparer.OrdinalIgnoreCase)
    {
        ["en"] = "Inglese", ["it"] = "Italiano", ["fr"] = "Francese", ["de"] = "Tedesco", ["es"] = "Spagnolo",
        ["ja"] = "Giapponese", ["zh"] = "Cinese", ["cn"] = "Cinese", ["ko"] = "Coreano", ["ru"] = "Russo",
        ["pt"] = "Portoghese", ["sv"] = "Svedese", ["da"] = "Danese", ["no"] = "Norvegese", ["nb"] = "Norvegese",
        ["fi"] = "Finlandese", ["nl"] = "Olandese", ["pl"] = "Polacco", ["cs"] = "Ceco", ["sk"] = "Slovacco",
        ["hu"] = "Ungherese", ["el"] = "Greco", ["tr"] = "Turco", ["ar"] = "Arabo", ["he"] = "Ebraico",
        ["hi"] = "Hindi", ["th"] = "Thailandese", ["la"] = "Latino", ["ga"] = "Irlandese", ["cy"] = "Gallese",
        ["yi"] = "Yiddish", ["fa"] = "Persiano", ["uk"] = "Ucraino", ["ro"] = "Rumeno", ["sr"] = "Serbo",
        ["hr"] = "Croato", ["bs"] = "Bosniaco", ["sl"] = "Sloveno", ["bg"] = "Bulgaro", ["is"] = "Islandese",
        ["et"] = "Estone", ["lv"] = "Lettone", ["lt"] = "Lituano", ["ca"] = "Catalano", ["eu"] = "Basco",
        ["gl"] = "Galiziano", ["vi"] = "Vietnamita", ["id"] = "Indonesiano", ["ms"] = "Malese", ["tl"] = "Tagalog",
        ["ta"] = "Tamil", ["te"] = "Telugu", ["bn"] = "Bengalese", ["ur"] = "Urdu", ["sw"] = "Swahili",
        ["zu"] = "Zulu", ["af"] = "Afrikaans", ["mn"] = "Mongolo", ["ka"] = "Georgiano", ["hy"] = "Armeno",
        ["eo"] = "Esperanto", ["sq"] = "Albanese", ["mk"] = "Macedone", ["pa"] = "Punjabi", ["ml"] = "Malayalam",
    };

    public static string NormalizeCountry(TmdbCountry c)
    {
        if (c.Iso is { } iso && CountryByIso.TryGetValue(iso, out var byIso)) return byIso;
        var name = c.Name?.Trim() ?? c.Iso ?? "";
        return CountryNormalize.GetValueOrDefault(name, name);
    }

    /// <summary>Nome italiano; null per "nessuna lingua" (<c>xx</c>).</summary>
    public static string? NormalizeLanguage(TmdbLanguage l)
    {
        if (l.Iso is "xx") return null;
        if (l.Iso is { } iso && LangByIso.TryGetValue(iso, out var it)) return it;
        var en = l.EnglishName?.Trim();
        if (string.IsNullOrEmpty(en)) return l.Name?.Trim() is { Length: > 0 } n ? n : null;
        return LangNormalize.GetValueOrDefault(en, en);
    }

    /// <summary>Tutti i valori ricavabili, prima del filtro sui campi della collezione.</summary>
    public static JsonObject FullDraft(TmdbMovie m)
    {
        var d = new JsonObject();
        if (!string.IsNullOrWhiteSpace(m.Title)) d["title"] = m.Title.Trim();
        if (!string.IsNullOrWhiteSpace(m.OriginalTitle)) d["original-title"] = m.OriginalTitle.Trim();
        if (TmdbClient.YearOf(m.ReleaseDate) is { } y) d["year"] = y;
        if (m.Runtime is > 0) d["running-time"] = m.Runtime.Value;
        if (!string.IsNullOrWhiteSpace(m.Overview)) d["plot"] = m.Overview.Trim();
        d["genre"] = Array(m.Genres.Select(g => g.Name));
        d["director"] = Array(m.Credits?.Crew.Where(c => c.Job == "Director").Select(c => c.Name) ?? []);
        var cast = new JsonArray();
        foreach (var c in (m.Credits?.Cast ?? []).OrderBy(c => c.Order).Where(c => !string.IsNullOrWhiteSpace(c.Name)).Take(MaxCast))
            cast.Add(new JsonObject { ["actor"] = c.Name!.Trim(), ["role"] = c.Character?.Trim() ?? "" });
        d["cast"] = cast;
        d["nationality"] = Array(m.ProductionCountries.Select(NormalizeCountry));
        d["language"] = Array(m.SpokenLanguages.Select(NormalizeLanguage));
        foreach (var k in d.Where(p => p.Value is JsonArray { Count: 0 }).Select(p => p.Key).ToList()) d.Remove(k);
        return d;
    }

    /// <summary>Bozza filtrata sui campi scrivibili della collezione, adattata a multiplo/singolo e al tipo.</summary>
    public static JsonObject ToDraft(JsonObject full, IReadOnlyList<CollectionField> fields)
    {
        var byName = fields.ToDictionary(f => f.Name, StringComparer.Ordinal);
        var draft = new JsonObject();
        foreach (var (name, value) in full)
        {
            if (value is null) continue;
            if (!byName.TryGetValue(name, out var field))
            {
                if (name == "title") draft[name] = value.DeepClone(); // il titolo è sempre ammesso
                continue;
            }
            if (field.Type is FieldTypes.Image or FieldTypes.Dependent || FieldCatalog.SystemFields.Contains(name)) continue;
            if (field.Type == FieldTypes.Table)
            {
                if (name == "cast") draft[name] = value.DeepClone();
                continue;
            }
            IEnumerable<JsonNode?> values = value is JsonArray a ? a : new[] { value };
            var items = values.Select(Convert(field)).Where(v => v is not null).ToList();
            if (items.Count == 0) continue;
            draft[name] = field.Multiple ? new JsonArray(items.ToArray()) : items[0];
        }
        return draft;
    }

    private static Func<JsonNode?, JsonNode?> Convert(CollectionField field) => node =>
    {
        if (node is not JsonValue v) return null;
        var isNumber = v.GetValueKind() == JsonValueKind.Number;
        return field.Type switch
        {
            FieldTypes.Number or FieldTypes.Rating => isNumber ? v.DeepClone()
                : long.TryParse(v.GetValue<string>(), out var l) ? JsonValue.Create(l) : null,
            FieldTypes.Bool or FieldTypes.Date or FieldTypes.Url => null,
            FieldTypes.Choice when field.Allowed is { Count: > 0 } allowed =>
                allowed.FirstOrDefault(x => string.Equals(x, isNumber ? v.ToJsonString() : v.GetValue<string>(),
                    StringComparison.OrdinalIgnoreCase)) is { } m ? JsonValue.Create(m) : null,
            _ => isNumber ? JsonValue.Create(v.ToJsonString()) : v.DeepClone(),
        };
    };

    private static JsonArray Array(IEnumerable<string?> values) =>
        new(values.Where(s => !string.IsNullOrWhiteSpace(s)).Select(s => s!.Trim()).Distinct(StringComparer.Ordinal)
            .Select(s => (JsonNode?)JsonValue.Create(s)).ToArray());
}
