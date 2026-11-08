using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace CineManager.Api.Auth;

/// <summary>Base64url senza padding (RFC 7515 §2), con decodifica rigorosa.</summary>
public static class Base64Url
{
    public static string Encode(ReadOnlySpan<byte> data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');

    /// <summary>
    /// Decodifica solo l'alfabeto base64url senza padding; null per qualsiasi altro carattere
    /// (anche <c>=</c>, <c>+</c>, <c>/</c>, spazi) o lunghezza impossibile.
    /// </summary>
    public static byte[]? TryDecode(string? s)
    {
        if (s is null) return null;
        if (s.Length % 4 == 1) return null;
        foreach (var c in s)
            if (!(char.IsAsciiLetterOrDigit(c) || c == '-' || c == '_')) return null;
        var b64 = s.Replace('-', '+').Replace('_', '/');
        b64 += (b64.Length % 4) switch { 2 => "==", 3 => "=", _ => "" };
        try { return Convert.FromBase64String(b64); }
        catch (FormatException) { return null; }
    }
}

/// <summary>Contenuto di un JWT di richiesta già verificato nel formato (non ancora nella firma).</summary>
public sealed record DeviceRequestToken(
    Guid DeviceId, long Iat, long Exp, string Jti, string Htm, string Htu, string? Bh, int Av,
    byte[] SigningInput, byte[] Signature);

/// <summary>
/// Formato delle richieste firmate dell'app (§4.2): JWT compatto ES256 con
/// <c>typ = cm-req+jwt</c> e <c>kid</c> = id del dispositivo. Parsing manuale e rigoroso:
/// algoritmo fisso (niente <c>alg:none</c> né altri), nessun header <c>crit</c>, firma R||S di 64 byte.
/// </summary>
public static class DeviceTokens
{
    public const string AuthorizationPrefix = "CM-Device ";
    public const string Type = "cm-req+jwt";
    public const string Algorithm = "ES256";
    public const int MaxTokenLength = 4096;

    /// <summary>OID della curva P-256 (secp256r1 / prime256v1).</summary>
    public const string P256Oid = "1.2.840.10045.3.1.7";

    /// <summary>Parsing del token; null con <paramref name="error"/> se il formato non è valido.</summary>
    public static DeviceRequestToken? TryParse(string token, out string error)
    {
        error = "invalid_token";
        if (string.IsNullOrEmpty(token) || token.Length > MaxTokenLength) return null;
        var parts = token.Split('.');
        if (parts.Length != 3) return null;

        var headerBytes = Base64Url.TryDecode(parts[0]);
        var payloadBytes = Base64Url.TryDecode(parts[1]);
        var sig = Base64Url.TryDecode(parts[2]);
        if (headerBytes is null || payloadBytes is null || sig is null || sig.Length != 64) return null;

        try
        {
            using var header = JsonDocument.Parse(headerBytes);
            var h = header.RootElement;
            if (h.ValueKind != JsonValueKind.Object) return null;
            if (!h.TryGetProperty("alg", out var alg) || alg.ValueKind != JsonValueKind.String || alg.GetString() != Algorithm)
            {
                error = "unsupported_alg";
                return null;
            }
            if (!h.TryGetProperty("typ", out var typ) || typ.ValueKind != JsonValueKind.String || typ.GetString() != Type)
                return null;
            if (h.TryGetProperty("crit", out _)) return null; // nessuna estensione critica supportata
            if (!h.TryGetProperty("kid", out var kid) || kid.ValueKind != JsonValueKind.String ||
                !Guid.TryParse(kid.GetString(), out var deviceId))
                return null;

            using var payload = JsonDocument.Parse(payloadBytes);
            var p = payload.RootElement;
            if (p.ValueKind != JsonValueKind.Object) return null;
            if (!TryInt64(p, "iat", out var iat) || !TryInt64(p, "exp", out var exp)) return null;
            if (!TryString(p, "jti", out var jti) || jti.Length is < 16 or > 128) return null;
            if (!TryString(p, "htm", out var htm) || !TryString(p, "htu", out var htu)) return null;
            string? bh = null;
            if (p.TryGetProperty("bh", out var bhEl))
            {
                if (bhEl.ValueKind != JsonValueKind.String) return null;
                bh = bhEl.GetString();
            }
            if (!p.TryGetProperty("av", out var avEl) || avEl.ValueKind != JsonValueKind.Number ||
                !avEl.TryGetInt32(out var av) || av < 0)
                return null;

            var signingInput = Encoding.ASCII.GetBytes(parts[0] + "." + parts[1]);
            error = "";
            return new DeviceRequestToken(deviceId, iat, exp, jti, htm, htu, bh, av, signingInput, sig);
        }
        catch (JsonException)
        {
            return null;
        }
    }

    /// <summary>Verifica la firma ES256 (R||S) con la chiave pubblica SPKI DER salvata.</summary>
    public static bool VerifySignature(byte[] spki, byte[] signingInput, byte[] signature)
    {
        try
        {
            using var key = ImportP256(spki);
            return key is not null && key.VerifyData(signingInput, signature, HashAlgorithmName.SHA256,
                DSASignatureFormat.IeeeP1363FixedFieldConcatenation);
        }
        catch (CryptographicException)
        {
            return false;
        }
    }

    /// <summary>Importa una chiave pubblica SPKI DER; null se non è una chiave EC sulla curva P-256.</summary>
    public static ECDsa? ImportP256(byte[] spki)
    {
        var key = ECDsa.Create();
        try
        {
            key.ImportSubjectPublicKeyInfo(spki, out var read);
            if (read != spki.Length) throw new CryptographicException("Byte in eccesso dopo la chiave.");
            var curve = key.ExportParameters(false).Curve;
            if (!curve.IsNamed || curve.Oid.Value != P256Oid) throw new CryptographicException("Curva non P-256.");
            return key;
        }
        catch (CryptographicException)
        {
            key.Dispose();
            return null;
        }
    }

    /// <summary>Base64url dello SHA-256 del corpo (claim <c>bh</c>).</summary>
    public static string BodyHash(ReadOnlySpan<byte> body) => Base64Url.Encode(SHA256.HashData(body));

    private static bool TryInt64(JsonElement o, string name, out long value)
    {
        value = 0;
        return o.TryGetProperty(name, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetInt64(out value);
    }

    private static bool TryString(JsonElement o, string name, out string value)
    {
        value = "";
        if (!o.TryGetProperty(name, out var el) || el.ValueKind != JsonValueKind.String) return false;
        value = el.GetString() ?? "";
        return value.Length > 0;
    }
}
