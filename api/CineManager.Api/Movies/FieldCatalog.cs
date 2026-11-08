using CineManager.Api.Data;
using Microsoft.EntityFrameworkCore;

namespace CineManager.Api.Movies;

/// <summary>
/// Definizioni dei campi da usare per modulo dell'app, validazione e CSV: quelle di
/// <c>collection_fields</c>, oppure, finché non c'è un import da Tellico, i campi standard della
/// collezione video di Tellico con i titoli inglesi più quelli creati dal sito.
/// </summary>
public static class FieldCatalog
{
    /// <summary>Campi di sistema di Tellico: mai scritti dall'app né esportati nel CSV.</summary>
    public static readonly HashSet<string> SystemFields = new(StringComparer.Ordinal) { "id", "cdate", "mdate" };

    /// <summary>Campo della copertina: lo imposta solo il server (download da TMDb).</summary>
    public const string CoverField = "cover";

    /// <summary>Titolo di ripiego della colonna codice a barre se il campo non è definito.</summary>
    public const string BarcodeFallbackTitle = "EAN";

    /// <summary>Campi standard della collezione video di Tellico (titoli inglesi), usati come ripiego.</summary>
    public static IReadOnlyList<CollectionField> Defaults { get; } = BuildDefaults();

    /// <summary>
    /// Campi della collezione. Senza campi di Tellico (nessun import ancora) i campi standard fanno
    /// da base e quelli creati dal sito si aggiungono (o sostituiscono lo standard con lo stesso nome).
    /// </summary>
    public static async Task<List<CollectionField>> LoadAsync(CinemaDbContext db, CancellationToken ct)
    {
        var rows = await db.CollectionFields.AsNoTracking()
            .OrderBy(f => f.Ordinal).ThenBy(f => f.Name).ToListAsync(ct);
        if (rows.Any(f => f.Origin == FieldOrigins.Tellico)) return rows;
        var local = rows.Select(f => f.Name).ToHashSet(StringComparer.Ordinal);
        return [.. Defaults.Where(f => !local.Contains(f.Name)).Concat(rows)
            .OrderBy(f => f.Ordinal).ThenBy(f => f.Name, StringComparer.Ordinal)];
    }

    private static List<CollectionField> BuildDefaults()
    {
        var list = new List<CollectionField>();
        void Add(string name, string title, string type, bool multiple = false, bool inForm = true,
            bool groupable = false, List<string>? allowed = null) =>
            list.Add(new CollectionField
            {
                Name = name, Title = title, Type = type, Multiple = multiple, Allowed = allowed,
                Origin = FieldOrigins.Tellico, Groupable = groupable, GroupMinSize = 3, InForm = inForm,
                Ordinal = list.Count,
            });

        Add("title", "Title", FieldTypes.Line);
        Add("medium", "Medium", FieldTypes.Choice, groupable: true,
            allowed: ["DVD", "VHS", "VCD", "DivX", "Blu-ray", "HD DVD"]);
        Add("year", "Production Year", FieldTypes.Number, groupable: true);
        Add("certification", "Certification", FieldTypes.Choice, inForm: false, groupable: true);
        Add("genre", "Genre", FieldTypes.Line, multiple: true, groupable: true);
        Add("region", "Region", FieldTypes.Choice, inForm: false, groupable: true);
        Add("nationality", "Nationality", FieldTypes.Line, multiple: true, groupable: true);
        Add("format", "Format", FieldTypes.Choice, inForm: false, groupable: true);
        Add("cast", "Cast", FieldTypes.Table);
        Add("director", "Director", FieldTypes.Line, multiple: true, groupable: true);
        Add("producer", "Producer", FieldTypes.Line, multiple: true, inForm: false, groupable: true);
        Add("writer", "Writer", FieldTypes.Line, multiple: true, inForm: false, groupable: true);
        Add("composer", "Composer", FieldTypes.Line, multiple: true, inForm: false, groupable: true);
        Add("studio", "Studio", FieldTypes.Line, multiple: true, groupable: true);
        Add("language", "Language Tracks", FieldTypes.Line, multiple: true, groupable: true);
        Add("subtitle", "Subtitle Languages", FieldTypes.Line, multiple: true, inForm: false, groupable: true);
        Add("audio-track", "Audio Tracks", FieldTypes.Line, multiple: true, inForm: false, groupable: true);
        Add("running-time", "Running Time", FieldTypes.Number);
        Add("aspect-ratio", "Aspect Ratios", FieldTypes.Line, multiple: true, inForm: false, groupable: true);
        Add("widescreen", "Widescreen", FieldTypes.Bool, inForm: false);
        Add("color", "Color Mode", FieldTypes.Choice, inForm: false, groupable: true);
        Add("directors-cut", "Director's Cut", FieldTypes.Bool, inForm: false);
        Add("plot", "Plot Summary", FieldTypes.Para);
        Add("rating", "Personal Rating", FieldTypes.Rating, inForm: false);
        Add("cover", "Front Cover", FieldTypes.Image, inForm: false);
        Add("comments", "Comments", FieldTypes.Para, inForm: false);
        Add("keyword", "Keywords", FieldTypes.Line, multiple: true, inForm: false, groupable: true);
        return list;
    }
}
