using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Import;

/// <summary>
/// IMPORTA DA TELLICO (§8): upsert di campi e film in una sola transazione.
/// </summary>
public sealed class TellicoImporter(
    CinemaDbContext db, IOptions<TellicoOptions> tellico, TimeProvider clock, ILogger<TellicoImporter> log)
{
    /// <summary>Soglie storiche del sito per i raggruppamenti fissi; 3 per tutti gli altri campi.</summary>
    private static readonly Dictionary<string, int> DefaultGroupMinSize = new()
    {
        ["genre"] = 3, ["director"] = 3, ["nationality"] = 4, ["language"] = 5, ["studio"] = 5,
    };
    private const int FallbackGroupMinSize = 3;

    /// <summary>Campi di sistema di Tellico che il modulo dell'app non deve proporre.</summary>
    private static readonly HashSet<string> SystemFields = ["id", "cdate", "mdate"];

    private sealed class Tracked(Movie movie)
    {
        public Movie Movie { get; } = movie;
        public bool Claimed { get; set; }
        private JsonObject? _data;
        public JsonObject Data => _data ??= JsonNode.Parse(Movie.Data) as JsonObject ?? new JsonObject();
    }

    public async Task<TellicoImportResult> ImportAsync(TellicoImportRequest req, CancellationToken ct)
    {
        var fields = req.Fields ?? throw new ImportValidationException("'fields' mancante.");
        var entries = req.Movies ?? throw new ImportValidationException("'movies' mancante.");
        var parsed = ValidateEntries(entries);
        ValidateFields(fields);

        var barcodeField = tellico.Value.BarcodeField;
        var now = clock.GetUtcNow();

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        // Un import alla volta (il lock si rilascia con la transazione).
        await db.Database.ExecuteSqlRawAsync("SELECT pg_advisory_xact_lock(7243100)", ct);

        // --- Campi ---------------------------------------------------------------------------
        var existingFields = await db.CollectionFields.ToDictionaryAsync(f => f.Name, ct);
        var incomingNames = fields.Select(f => f.Name).ToHashSet(StringComparer.Ordinal);
        // Campi `local` che il .tc non conosce: i loro valori nei film vanno conservati.
        var preservedLocal = existingFields.Values
            .Where(f => f.Origin == FieldOrigins.Local && !incomingNames.Contains(f.Name))
            .Select(f => f.Name).ToList();
        var fieldsUpdated = UpsertFields(fields, existingFields);

        // --- Film ----------------------------------------------------------------------------
        var all = (await db.Movies.ToListAsync(ct)).Select(m => new Tracked(m)).ToList();
        var byId = all.ToDictionary(t => t.Movie.Id);
        var byTellico = all.Where(t => t.Movie.TellicoId is not null).ToDictionary(t => t.Movie.TellicoId!.Value);
        var byEan = all.Where(t => t.Movie.Ean is not null).ToDictionary(t => t.Movie.Ean!, StringComparer.Ordinal);
        Dictionary<string, List<Tracked>>? byTitleYear = null; // costruito solo se serve

        int inserted = 0, updated = 0, linked = 0, unchanged = 0;

        foreach (var (tid, entry) in parsed)
        {
            var ean = EanNormalizer.Normalize(TitleNormalizer.AsString(entry[barcodeField]));
            Tracked? match = null;

            // 1. EAN
            if (ean is not null && byEan.TryGetValue(ean, out var e) && !e.Claimed) match = e;

            // 2. tellico_id, con controllo di identità su cdate (id riusato da Tellico)
            if (match is null && byTellico.TryGetValue(tid, out var t) && !t.Claimed)
            {
                var oldCdate = TitleNormalizer.AsString(t.Data["cdate"]);
                var newCdate = TitleNormalizer.AsString(entry["cdate"]);
                if (!string.IsNullOrEmpty(oldCdate) && !string.IsNullOrEmpty(newCdate) && oldCdate != newCdate)
                {
                    log.LogInformation("Id Tellico {Tid} riusato (cdate {Old} → {New}): il film {Id} perde il collegamento",
                        tid, oldCdate, newCdate, t.Movie.Id);
                    await SetTellicoIdAsync(t, null, byTellico, ct);
                }
                else match = t;
            }

            // 3. titolo + anno, solo tra gli arrivi dall'app non collegati
            if (match is null && TitleNormalizer.Key(entry) is { } key)
            {
                byTitleYear ??= BuildTitleIndex(all);
                if (byTitleYear.TryGetValue(key, out var list))
                    match = list.Where(c => !c.Claimed && c.Movie.Source == MovieSources.App && c.Movie.TellicoId is null)
                        .OrderBy(c => c.Movie.Id).FirstOrDefault();
            }

            var newData = (JsonObject)entry.DeepClone();
            newData.Remove("id");

            // 4. nuovo film
            if (match is null)
            {
                if (byTellico.TryGetValue(tid, out var holder)) await SetTellicoIdAsync(holder, null, byTellico, ct);
                var id = tid;
                while (byId.ContainsKey(id)) id = await db.NextMovieIdAsync(ct);
                var movie = new Movie
                {
                    Id = id, TellicoId = tid, Source = MovieSources.Tellico,
                    Data = newData.ToJsonString(), CreatedAt = now, UpdatedAt = now,
                };
                if (ean is not null)
                {
                    if (!byEan.ContainsKey(ean)) movie.Ean = ean;
                    else log.LogWarning("EAN {Ean} dell'entry {Tid} già usato da un altro film del .tc: ignorato", ean, tid);
                }
                db.Movies.Add(movie);
                var tr = new Tracked(movie) { Claimed = true };
                byId[id] = tr;
                byTellico[tid] = tr;
                if (movie.Ean is not null) byEan[movie.Ean] = tr;
                all.Add(tr);
                inserted++;
                continue;
            }

            // --- Aggiornamento del film abbinato
            match.Claimed = true;
            var m = match.Movie;
            var old = match.Data;

            if (IsEmpty(newData["cover"]) && !IsEmpty(old["cover"]))
                newData["cover"] = old["cover"]!.DeepClone();
            foreach (var name in preservedLocal)
                if (!newData.ContainsKey(name) && old.TryGetPropertyValue(name, out var v))
                    newData[name] = v?.DeepClone();

            var wasLinked = m.TellicoId == tid;
            var changed = false;
            if (!wasLinked)
            {
                if (byTellico.TryGetValue(tid, out var holder) && holder != match)
                    await SetTellicoIdAsync(holder, null, byTellico, ct);
                await SetTellicoIdAsync(match, tid, byTellico, ct);
                changed = true;
            }
            if (ean is not null && m.Ean != ean)
            {
                if (byEan.TryGetValue(ean, out var other) && other != match)
                    log.LogWarning("EAN {Ean} dell'entry {Tid} già usato da un altro film del .tc: ignorato", ean, tid);
                else
                {
                    if (m.Ean is not null) byEan.Remove(m.Ean);
                    m.Ean = ean;
                    byEan[ean] = match;
                    await db.SaveChangesAsync(ct); // libera subito il vecchio EAN (vincolo unique)
                    changed = true;
                }
            }
            if (m.Source != MovieSources.Tellico) { m.Source = MovieSources.Tellico; changed = true; }
            if (!JsonNode.DeepEquals(old, newData))
            {
                m.Data = newData.ToJsonString();
                changed = true;
            }

            if (!wasLinked) linked++;
            else if (changed) updated++;
            else unchanged++;
            if (changed) m.UpdatedAt = now;
        }

        await db.SaveChangesAsync(ct);
        await tx.CommitAsync(ct);

        var missing = all
            .Where(t => !t.Claimed && t.Movie.Source == MovieSources.Tellico)
            .OrderBy(t => t.Movie.Id)
            .Select(t => new MissingMovie(t.Movie.Id, TitleNormalizer.AsString(t.Data["title"])))
            .ToList();

        log.LogInformation(
            "Import Tellico: {Inserted} nuovi, {Updated} aggiornati, {Linked} collegati, {Unchanged} invariati, {Missing} mancanti, {Fields} campi",
            inserted, updated, linked, unchanged, missing.Count, fieldsUpdated);
        return new TellicoImportResult(inserted, updated, linked, unchanged, missing, fieldsUpdated);
    }

    /// <summary>
    /// Cambia il <c>tellico_id</c> di un film tenendo aggiornato l'indice e salvando subito, così
    /// il valore liberato è riutilizzabile nella stessa transazione senza violare il vincolo unique.
    /// </summary>
    private async Task SetTellicoIdAsync(Tracked t, int? value, Dictionary<int, Tracked> byTellico, CancellationToken ct)
    {
        if (t.Movie.TellicoId is { } oldId && byTellico.TryGetValue(oldId, out var cur) && cur == t)
            byTellico.Remove(oldId);
        t.Movie.TellicoId = value;
        t.Movie.UpdatedAt = clock.GetUtcNow();
        if (value is { } v) byTellico[v] = t;
        await db.SaveChangesAsync(ct);
    }

    private static Dictionary<string, List<Tracked>> BuildTitleIndex(IEnumerable<Tracked> all)
    {
        var idx = new Dictionary<string, List<Tracked>>(StringComparer.Ordinal);
        foreach (var t in all.Where(t => t.Movie.Source == MovieSources.App && t.Movie.TellicoId is null))
        {
            if (TitleNormalizer.Key(t.Data) is not { } k) continue;
            if (!idx.TryGetValue(k, out var l)) idx[k] = l = [];
            l.Add(t);
        }
        return idx;
    }

    private static bool IsEmpty(JsonNode? n) =>
        n is null || (n is JsonValue v && v.TryGetValue<string>(out var s) && string.IsNullOrWhiteSpace(s));

    /// <summary>
    /// Aggiorna <c>collection_fields</c> (§5): titolo, tipo, multiplo e valori ammessi da Tellico;
    /// le preferenze del sito (groupable, group_min_size, in_form, ordinal) restano se già presenti.
    /// Un campo `local` omonimo diventa `tellico`; i campi `tellico` spariti dal .tc vengono rimossi.
    /// </summary>
    private int UpsertFields(List<TellicoField> fields, Dictionary<string, CollectionField> existing)
    {
        var count = 0;
        var nextOrdinal = existing.Count == 0 ? 0 : existing.Values.Max(f => f.Ordinal) + 1;
        foreach (var f in fields)
        {
            if (f.Name == "id") continue; // l'id è la colonna movies.id, non un valore di data
            var type = TellicoFieldTypes.Map(f.Type, f.Flags);
            var multiple = f.Multiple ?? (f.Flags & TellicoFieldTypes.FlagAllowMultiple) != 0;
            var title = string.IsNullOrWhiteSpace(f.Title) ? f.Name : f.Title.Trim();
            var allowed = f.Allowed is { Count: > 0 } a ? a : null;

            if (existing.TryGetValue(f.Name, out var row))
            {
                var same = row.Title == title && row.Type == type && row.Multiple == multiple &&
                           row.Origin == FieldOrigins.Tellico &&
                           (row.Allowed ?? []).SequenceEqual(allowed ?? []);
                if (same) continue;
                row.Title = title;
                row.Type = type;
                row.Multiple = multiple;
                row.Allowed = allowed;
                row.Origin = FieldOrigins.Tellico;
                count++;
                continue;
            }

            var groupable = f.Groupable ?? (f.Flags & TellicoFieldTypes.FlagAllowGrouped) != 0;
            var inForm = type is not (FieldTypes.Dependent or FieldTypes.Image) &&
                         (f.Flags & TellicoFieldTypes.FlagNoEdit) == 0 && !SystemFields.Contains(f.Name);
            db.CollectionFields.Add(new CollectionField
            {
                Name = f.Name, Title = title, Type = type, Multiple = multiple, Allowed = allowed,
                Origin = FieldOrigins.Tellico, Groupable = groupable,
                GroupMinSize = DefaultGroupMinSize.GetValueOrDefault(f.Name, FallbackGroupMinSize),
                InForm = inForm, Ordinal = nextOrdinal++,
            });
            count++;
        }

        var incoming = fields.Select(f => f.Name).ToHashSet(StringComparer.Ordinal);
        foreach (var gone in existing.Values.Where(f => f.Origin == FieldOrigins.Tellico && !incoming.Contains(f.Name)))
        {
            db.CollectionFields.Remove(gone);
            count++;
        }
        return count;
    }

    private static List<(int Tid, JsonObject Entry)> ValidateEntries(List<JsonObject> entries)
    {
        var seen = new HashSet<int>();
        var result = new List<(int, JsonObject)>(entries.Count);
        for (var i = 0; i < entries.Count; i++)
        {
            var e = entries[i] ?? throw new ImportValidationException($"movies[{i}]: valore nullo.");
            if (e["id"] is not JsonValue idv || !idv.TryGetValue<int>(out var id) || id <= 0)
                throw new ImportValidationException($"movies[{i}]: 'id' mancante o non intero positivo.");
            if (!seen.Add(id))
                throw new ImportValidationException($"movies[{i}]: id {id} duplicato.");
            result.Add((id, e));
        }
        return result;
    }

    private static void ValidateFields(List<TellicoField> fields)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var f in fields)
        {
            if (f is null || string.IsNullOrWhiteSpace(f.Name) || f.Name.Length > 100)
                throw new ImportValidationException("Campo con 'name' mancante o troppo lungo.");
            if (!names.Add(f.Name))
                throw new ImportValidationException($"Campo '{f.Name}' duplicato.");
        }
    }
}
