using System.Text.RegularExpressions;
using CineManager.Api.Infrastructure;
using Microsoft.Extensions.Options;

namespace CineManager.Api.Import;

/// <summary>Scrittura delle copertine in <c>Covers__Path</c> (§8, immagini incorporate).</summary>
public sealed partial class CoverStore(IOptions<CoversOptions> options, IWebHostEnvironment env, ILogger<CoverStore> log)
{
    [GeneratedRegex("^[A-Za-z0-9._-]{1,200}$")]
    private static partial Regex SafeName();

    /// <summary>Nome file ammesso: solo <c>[A-Za-z0-9._-]</c>, senza punto iniziale (niente <c>..</c> o file nascosti).</summary>
    public static bool IsSafeName(string name) => SafeName().IsMatch(name) && name[0] != '.';

    public string Root
    {
        get
        {
            var p = options.Value.Path;
            if (string.IsNullOrWhiteSpace(p))
                throw new InvalidOperationException("Covers__Path non configurato.");
            return Path.GetFullPath(Path.IsPathRooted(p) ? p : Path.Combine(env.ContentRootPath, p));
        }
    }

    /// <summary>
    /// Valida tutto il lotto (nomi e base64) prima di scrivere; poi scrive solo i file che non
    /// esistono, in modo atomico (file temporaneo nella stessa cartella + rename senza sovrascrittura).
    /// </summary>
    public async Task<ImagesImportResult> WriteAsync(IReadOnlyDictionary<string, string> images, CancellationToken ct)
    {
        var decoded = new List<(string Name, byte[] Bytes)>(images.Count);
        foreach (var (name, b64) in images)
        {
            if (!IsSafeName(name))
                throw new ImportValidationException($"Nome immagine non valido: '{Truncate(name)}' (ammessi solo A-Z a-z 0-9 . _ -).");
            if (string.IsNullOrEmpty(b64))
                throw new ImportValidationException($"Immagine '{name}' vuota.");
            try { decoded.Add((name, Convert.FromBase64String(b64))); }
            catch (FormatException) { throw new ImportValidationException($"Immagine '{name}': base64 non valido."); }
        }

        var root = Root;
        Directory.CreateDirectory(root);
        int written = 0, skipped = 0;
        foreach (var (name, bytes) in decoded)
        {
            ct.ThrowIfCancellationRequested();
            var dest = Path.Combine(root, name);
            if (File.Exists(dest)) { skipped++; continue; }
            var tmp = Path.Combine(root, $".tmp-{Guid.NewGuid():N}");
            try
            {
                await File.WriteAllBytesAsync(tmp, bytes, ct);
                File.Move(tmp, dest, overwrite: false);
                written++;
            }
            catch (IOException) when (File.Exists(dest))
            {
                skipped++; // scritto nel frattempo da un'altra richiesta
            }
            finally
            {
                if (File.Exists(tmp)) File.Delete(tmp);
            }
        }
        log.LogInformation("Import immagini: {Written} scritte, {Skipped} già presenti", written, skipped);
        return new ImagesImportResult(written, skipped);
    }

    private static string Truncate(string s) => s.Length <= 60 ? s : s[..60] + "…";
}
