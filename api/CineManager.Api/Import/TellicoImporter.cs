using System.Text.Json.Nodes;
using CineManager.Api.Data;
using CineManager.Api.Infrastructure;
using CineManager.Api.Movies;
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

    /// <summary>Al massimo tanti avvisi nel riepilogo (gli altri solo contati).</summary>
    private const int MaxWarnings = 50;

    private sealed class Tracked(Movie movie)
    {
        public Movie Movie { get; } = movie;
        public bool Claimed { get; set; }
        private JsonObject? _data;
        public JsonObject Data => _data ??= Movie.ParseData(Movie.Data);
        public void SetData(JsonObject data)
        {
            Movie.Data = data.ToJsonString();
            _data = null;
        }
    }

    public async Task<TellicoImportResult> ImportAsync(TellicoImportRequest req, CancellationToken ct)
    {
        var fields = req.Fields ?? throw new ImportValidationException("'fields' mancante.");
        var entries = req.Movies ?? throw new ImportValidationException("'movies' mancante.");
        var parsed = ValidateEntries(entries);
        ValidateFields(fields);

        var barcodeField = tellico.Value.BarcodeField;
        var now = clock.GetUtcNow();
        var warnings = new List<string>();
        // EAN finale di ogni entry (validato, unico nel .tc) e, al contrario, entry che lo possiede.
        var entryEan = ResolveEans(parsed, barcodeField, warnings);
        var eanOwner = entryEan.Where(kv => kv.Value is not null).ToDictionary(kv => kv.Value!, kv => kv.Key, StringComparer.Ordinal);
        var tidsInFile = parsed.Select(p => p.Tid).ToHashSet();

        await using var tx = await db.Database.BeginTransactionAsync(ct);
        // Esclusivo: nessun arrivo, PATCH o DELETE in parallelo (prendono lo stesso lock condiviso).
        await CollectionLock.ExclusiveAsync(db, ct);

        // --- Campi ---------------------------------------------------------------------------
        var existingFields = await db.CollectionFields.ToDictionaryAsync(f => f.Name, ct);
        var incomingNames = fields.Select(f => f.Name).ToHashSet(StringComparer.Ordinal);
        // Campi `local` che il .tc non conosce: i loro valori nei film vanno conservati.
        var preservedLocal = existingFields.Values
            .Where(f => f.Origin == FieldOrigins.Local && !incomingNames.Contains(f.Name))
            .Select(f => f.Name).ToList();
        var fieldsUpdated = UpsertFields(fields, incomingNames, existingFields);

        // --- Film ----------------------------------------------------------------------------
        var all = (await db.Movies.ToListAsync(ct)).Select(m => new Tracked(m)).ToList();
        var byId = all.ToDictionary(t => t.Movie.Id);
        var byTellico = all.Where(t => t.Movie.TellicoId is not null).ToDictionary(t => t.Movie.TellicoId!.Value);
        var byEan = all.Where(t => t.Movie.Ean is not null).ToDictionary(t => t.Movie.Ean!, StringComparer.Ordinal);
        Dictionary<string, List<Tracked>>? byTitleYear = null; // costruito solo se serve

        // Toglie l'EAN (colonna e data) al film che lo tiene, se non è `keep`: il .tc lo assegna altrove.
        async Task ReleaseEanAsync(string ean, Tracked? keep, int tid)
        {
            if (!byEan.TryGetValue(ean, out var holder) || holder == keep) return;
            log.LogInformation("EAN {Ean} passa dal film {From} all'entry {Tid}", ean, holder.Movie.Id, tid);
            byEan.Remove(ean);
            holder.Movie.Ean = null;
            var d = holder.Data.DeepClone().AsObject();
            if (d.Remove(barcodeField)) holder.SetData(d);
            holder.Movie.UpdatedAt = now;
            await db.SaveChangesAsync(ct); // libera subito il valore (vincolo unique)
        }

        int inserted = 0, updated = 0, linked = 0, unchanged = 0;

        foreach (var (tid, entry) in parsed)
        {
            var ean = entryEan[tid];
            Tracked? match = null;

            // 1. EAN: solo arrivi non collegati, il film già di questa entry o uno collegato a un id
            //    sparito dal .tc. Un film collegato a un'altra entry presente non si "ruba": l'EAN è
            //    stato spostato in Tellico e lo riceverà l'entry giusta (sotto).
            if (ean is not null && byEan.TryGetValue(ean, out var e) && !e.Claimed &&
                (e.Movie.TellicoId is not { } eTid || eTid == tid || !tidsInFile.Contains(eTid)))
                match = e;

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

            // 3. titolo + anno, solo tra gli arrivi dall'app non collegati e senza un EAN diverso
            //    (stesso film in un'altra edizione, es. DVD e Blu-ray, resta distinto)
            if (match is null && TitleNormalizer.Key(entry) is { } key)
            {
                byTitleYear ??= BuildTitleIndex(all);
                if (byTitleYear.TryGetValue(key, out var list))
                    match = list.Where(c => !c.Claimed && c.Movie.Source == MovieSources.App && c.Movie.TellicoId is null &&
                                            (c.Movie.Ean is null || (ean is null && !eanOwner.ContainsKey(c.Movie.Ean))))
                        .OrderBy(c => c.Movie.Id).FirstOrDefault();
            }

            var newData = (JsonObject)entry.DeepClone();
            newData.Remove("id");

            // 4. nuovo film
            if (match is null)
            {
                if (byTellico.TryGetValue(tid, out var holder)) await SetTellicoIdAsync(holder, null, byTellico, ct);
                if (ean is not null) await ReleaseEanAsync(ean, null, tid);
                var id = tid;
                while (byId.ContainsKey(id)) id = await db.NextMovieIdAsync(ct);
                Movie.SetBarcode(newData, barcodeField, ean);
                var movie = new Movie
                {
                    Id = id, TellicoId = tid, Source = MovieSources.Tellico, Ean = ean,
                    Data = newData.ToJsonString(), CreatedAt = now, UpdatedAt = now,
                };
                db.Movies.Add(movie);
                var tr = new Tracked(movie) { Claimed = true };
                byId[id] = tr;
                byTellico[tid] = tr;
                if (ean is not null) byEan[ean] = tr;
                all.Add(tr);
                inserted++;
                continue;
            }

            // --- Aggiornamento del film abbinato
            match.Claimed = true;
            var m = match.Movie;
            var old = match.Data;

            if (MovieValidator.IsEmptyValue(newData["cover"]) && !MovieValidator.IsEmptyValue(old["cover"]))
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
            // EAN: quello dell'entry; senza, resta il precedente purché il .tc non l'abbia dato a un'altra entry.
            var targetEan = ean ?? (m.Ean is not null && !eanOwner.ContainsKey(m.Ean) ? m.Ean : null);
            if (targetEan != m.Ean)
            {
                if (targetEan is not null) await ReleaseEanAsync(targetEan, match, tid);
                if (m.Ean is not null && byEan.TryGetValue(m.Ean, out var cur) && cur == match) byEan.Remove(m.Ean);
                m.Ean = targetEan;
                if (targetEan is not null) byEan[targetEan] = match;
                await db.SaveChangesAsync(ct); // libera subito il vecchio EAN (vincolo unique)
                changed = true;
            }
            Movie.SetBarcode(newData, barcodeField, m.Ean);
            if (m.Source != MovieSources.Tellico) { m.Source = MovieSources.Tellico; changed = true; }
            if (!JsonNode.DeepEquals(old, newData))
            {
                match.SetData(newData);
                changed = true;
            }

            if (!wasLinked) linked++;
            else if (changed) updated++;
            else unchanged++;
            if (changed) m.UpdatedAt = now;
        }

        await db.SaveChangesAsync(ct);
        // Un id Tellico ≥ 1 000 000 non deve poi scontrarsi con la sequenza degli arrivi.
        await db.Database.ExecuteSqlRawAsync($"""
            SELECT setval('{CinemaDbContext.MovieIdSequence}', GREATEST(
                (SELECT COALESCE(MAX(id), 0) FROM movies),
                (SELECT CASE WHEN is_called THEN last_value ELSE last_value - 1 END FROM {CinemaDbContext.MovieIdSequence})))
            """, ct);
        await tx.CommitAsync(ct);

        var missing = all
            .Where(t => !t.Claimed && t.Movie.Source == MovieSources.Tellico)
            .OrderBy(t => t.Movie.Id)
            .Select(t => new MissingMovie(t.Movie.Id, TitleNormalizer.AsString(t.Data["title"])))
            .ToList();

        if (warnings.Count > MaxWarnings)
            warnings = [.. warnings.Take(MaxWarnings), $"… e altri {warnings.Count - MaxWarnings} avvisi."];
        log.LogInformation(
            "Import Tellico: {Inserted} nuovi, {Updated} aggiornati, {Linked} collegati, {Unchanged} invariati, {Missing} mancanti, {Fields} campi, {Warnings} avvisi",
            inserted, updated, linked, unchanged, missing.Count, fieldsUpdated, warnings.Count);
        return new TellicoImportResult(inserted, updated, linked, unchanged, missing, fieldsUpdated, warnings);
    }

    /// <summary>
    /// EAN di ogni entry: normalizzato e validato come negli arrivi (8–14 cifre); un valore non
    /// valido o già usato da un'entry precedente del .tc viene ignorato con un avviso.
    /// </summary>
    private Dictionary<int, string?> ResolveEans(List<(int Tid, JsonObject Entry)> parsed, string barcodeField, List<string> warnings)
    {
        var result = new Dictionary<int, string?>();
        var firstByEan = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var (tid, entry) in parsed)
        {
            string? ean = null;
            var raw = TitleNormalizer.AsString(entry[barcodeField]);
            if (!string.IsNullOrWhiteSpace(raw))
            {
                var n = EanNormalizer.Normalize(raw);
                var shown = raw.Length <= 40 ? raw : raw[..40] + "…";
                if (n is null || !MovieValidator.IsValidEan(n))
                    warnings.Add($"Entry {tid}: codice a barre \"{shown}\" non valido (servono 8–14 cifre), ignorato.");
                else if (firstByEan.TryGetValue(n, out var first))
                    warnings.Add($"Entry {tid}: EAN {n} già usato dall'entry {first}, ignorato.");
                else
                {
                    firstByEan[n] = tid;
                    ean = n;
                }
            }
            result[tid] = ean;
        }
        foreach (var w in warnings) log.LogWarning("Import Tellico: {Warning}", w);
        return result;
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

    /// <summary>
    /// Aggiorna <c>collection_fields</c> (§5): titolo, tipo, multiplo e valori ammessi da Tellico;
    /// le preferenze del sito (groupable, group_min_size, in_form, ordinal) restano se già presenti.
    /// Un campo `local` omonimo diventa `tellico`; i campi `tellico` spariti dal .tc vengono rimossi.
    /// </summary>
    private int UpsertFields(List<TellicoField> fields, HashSet<string> incoming, Dictionary<string, CollectionField> existing)
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
                         (f.Flags & TellicoFieldTypes.FlagNoEdit) == 0 && !FieldCatalog.SystemFields.Contains(f.Name);
            db.CollectionFields.Add(new CollectionField
            {
                Name = f.Name, Title = title, Type = type, Multiple = multiple, Allowed = allowed,
                Origin = FieldOrigins.Tellico, Groupable = groupable,
                GroupMinSize = DefaultGroupMinSize.GetValueOrDefault(f.Name, FallbackGroupMinSize),
                InForm = inForm, Ordinal = nextOrdinal++,
            });
            count++;
        }

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
            if (JsonSafety.Problem(e) is { } problem)
                throw new ImportValidationException($"movies[{i}]: {problem}");
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
            if (JsonSafety.HasNul(f.Name) || JsonSafety.HasNul(f.Title) || JsonSafety.HasNul(f.Type) ||
                f.Allowed?.Any(JsonSafety.HasNul) == true)
                throw new ImportValidationException($"Campo '{f.Name.Replace("\0", "")}': {JsonSafety.NulMessage}");
        }
    }
}
