using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using CineManager.Api.Auth;

namespace CineManager.Api.Tests.Support;

/// <summary>
/// Telefono finto: chiave P-256 come quella del Keystore e firma delle richieste come farà
/// l'app (§4.2). I parametri facoltativi permettono di costruire token alterati per i test.
/// </summary>
public sealed class TestDevice : IDisposable
{
    public ECDsa Key { get; } = ECDsa.Create(ECCurve.NamedCurves.nistP256);
    public Guid Id { get; set; }
    public int VersionCode { get; set; } = 10000;

    /// <summary>Chiave pubblica SPKI DER in base64 (formato di <c>publicKey</c> in <c>pair</c>).</summary>
    public string PublicKey => Convert.ToBase64String(Key.ExportSubjectPublicKeyInfo());

    /// <summary>Firma ES256 (R||S, base64url) di <c>"pair:" + code</c>.</summary>
    public string Proof(string code) => Base64Url.Encode(Sign(Encoding.UTF8.GetBytes("pair:" + code)));

    public byte[] Sign(byte[] data) =>
        Key.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    /// <summary>
    /// JWT di richiesta. <paramref name="tamper"/> modifica header e payload prima della firma;
    /// <paramref name="sign"/> sostituisce la firma (es. altra chiave o firma vuota).
    /// </summary>
    public string Token(string method, string pathAndQuery, byte[]? body, DateTimeOffset? now = null,
        Action<JsonObject, JsonObject>? tamper = null, Func<byte[], byte[]>? sign = null)
    {
        var t = (now ?? DateTimeOffset.UtcNow).ToUnixTimeSeconds();
        var header = new JsonObject { ["alg"] = "ES256", ["typ"] = "cm-req+jwt", ["kid"] = Id.ToString() };
        var payload = new JsonObject
        {
            ["iat"] = t, ["exp"] = t + 60, ["jti"] = Base64Url.Encode(RandomNumberGenerator.GetBytes(16)),
            ["htm"] = method, ["htu"] = pathAndQuery, ["av"] = VersionCode,
        };
        if (body is { Length: > 0 }) payload["bh"] = Base64Url.Encode(SHA256.HashData(body));
        tamper?.Invoke(header, payload);
        var input = Base64Url.Encode(Encoding.UTF8.GetBytes(header.ToJsonString())) + "." +
                    Base64Url.Encode(Encoding.UTF8.GetBytes(payload.ToJsonString()));
        var sig = (sign ?? Sign)(Encoding.ASCII.GetBytes(input));
        return input + "." + Base64Url.Encode(sig);
    }

    /// <summary>Richiesta firmata pronta da inviare.</summary>
    public HttpRequestMessage Request(HttpMethod method, string pathAndQuery, string? json = null,
        DateTimeOffset? now = null, Action<JsonObject, JsonObject>? tamper = null, Func<byte[], byte[]>? sign = null)
    {
        var body = json is null ? null : Encoding.UTF8.GetBytes(json);
        var req = new HttpRequestMessage(method, pathAndQuery);
        if (body is not null)
        {
            req.Content = new ByteArrayContent(body);
            req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        }
        req.Headers.TryAddWithoutValidation("Authorization",
            DeviceTokens.AuthorizationPrefix + Token(method.Method, pathAndQuery, body, now, tamper, sign));
        return req;
    }

    public void Dispose() => Key.Dispose();
}

/// <summary>Handler HTTP finto: risponde con <see cref="Responder"/> e registra le richieste.</summary>
public sealed class FakeHttp : HttpMessageHandler
{
    public Func<HttpRequestMessage, HttpResponseMessage> Responder { get; set; } =
        _ => new HttpResponseMessage(System.Net.HttpStatusCode.NotFound);

    public List<Uri> Requests { get; } = [];

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct)
    {
        lock (Requests) Requests.Add(request.RequestUri!);
        return Task.FromResult(Responder(request));
    }

    public static HttpResponseMessage Json(string json, System.Net.HttpStatusCode status = System.Net.HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static HttpResponseMessage Bytes(byte[] bytes, string contentType)
    {
        var res = new HttpResponseMessage(System.Net.HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
        res.Content.Headers.ContentType = new MediaTypeHeaderValue(contentType);
        return res;
    }
}
