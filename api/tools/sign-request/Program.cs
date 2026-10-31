// sign-request: "telefono" finto per provare l'API senza l'app Android (docs/api.md).
//
//   sign-request keygen --key dev.json
//   sign-request pair   --key dev.json (--qr '<json del QR>' | --api http://localhost:5080/api --code <code>) [--name "Prova"]
//   sign-request send   --key dev.json [--av 10000] GET /api/app/me
//   sign-request send   --key dev.json POST /api/app/movies --json '{"movie":{"title":"X"}}'
//   sign-request token  --key dev.json GET /api/app/me        → valore dell'header Authorization (per curl)
//
// Il file della chiave contiene la chiave privata in chiaro: solo per sviluppo e prove.

using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

return await Cli.RunAsync(args);

internal static class Cli
{
    private const string Usage = """
        Uso:
          sign-request keygen --key FILE
          sign-request pair   --key FILE (--qr JSON | --api URL --code CODICE) [--name NOME]
          sign-request send   --key FILE [--av N] METODO PERCORSO [--json CORPO | --json-file FILE]
          sign-request token  --key FILE [--av N] METODO PERCORSO [--json CORPO | --json-file FILE]

        PERCORSO è relativo all'origine dell'API salvata da pair (es. /api/app/lookup?ean=8012345678901).
        """;

    public static async Task<int> RunAsync(string[] args)
    {
        if (args.Length == 0 || args[0] is "-h" or "--help")
        {
            Console.WriteLine(Usage);
            return args.Length == 0 ? 2 : 0;
        }
        try
        {
            var (opts, rest) = Parse(args[1..]);
            var keyFile = opts.GetValueOrDefault("key") ?? throw new UsageException("--key obbligatorio.");
            switch (args[0])
            {
                case "keygen":
                    KeyFile.Create(keyFile);
                    Console.WriteLine($"Chiave P-256 creata in {keyFile}");
                    return 0;
                case "pair":
                    return await PairAsync(KeyFile.Load(keyFile), keyFile, opts);
                case "send":
                case "token":
                {
                    if (rest.Count != 2) throw new UsageException("Servono METODO e PERCORSO.");
                    var key = KeyFile.Load(keyFile);
                    var body = opts.TryGetValue("json", out var j) ? j
                        : opts.TryGetValue("json-file", out var f) ? await File.ReadAllTextAsync(f) : null;
                    var av = opts.TryGetValue("av", out var a) ? int.Parse(a) : 10000;
                    var method = rest[0].ToUpperInvariant();
                    var url = key.Url(rest[1]);
                    var bytes = body is null ? null : Encoding.UTF8.GetBytes(body);
                    var header = "CM-Device " + key.Token(method, url.PathAndQuery, bytes, av);
                    if (args[0] == "token")
                    {
                        Console.WriteLine(header);
                        return 0;
                    }
                    return await SendAsync(method, url, header, bytes);
                }
                default:
                    throw new UsageException($"Comando sconosciuto: {args[0]}");
            }
        }
        catch (UsageException ex)
        {
            Console.Error.WriteLine(ex.Message);
            Console.Error.WriteLine(Usage);
            return 2;
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or JsonException or FormatException)
        {
            Console.Error.WriteLine("Errore: " + ex.Message);
            return 1;
        }
    }

    private static async Task<int> PairAsync(KeyFile key, string keyFile, Dictionary<string, string> opts)
    {
        string api, code;
        if (opts.TryGetValue("qr", out var qr))
        {
            var o = JsonNode.Parse(qr) ?? throw new UsageException("QR non valido.");
            api = o["api"]?.GetValue<string>() ?? throw new UsageException("QR senza 'api'.");
            code = o["code"]?.GetValue<string>() ?? throw new UsageException("QR senza 'code'.");
        }
        else
        {
            api = opts.GetValueOrDefault("api") ?? throw new UsageException("Servono --qr oppure --api e --code.");
            code = opts.GetValueOrDefault("code") ?? throw new UsageException("Servono --qr oppure --api e --code.");
        }
        api = api.TrimEnd('/');
        var body = JsonSerializer.Serialize(new
        {
            code,
            deviceName = opts.GetValueOrDefault("name") ?? "sign-request " + Environment.MachineName,
            publicKey = key.PublicKey,
            proof = Base64Url.Encode(key.Sign(Encoding.UTF8.GetBytes("pair:" + code))),
        });
        using var http = new HttpClient();
        using var res = await http.PostAsync(api + "/app/pair", new StringContent(body, Encoding.UTF8, "application/json"));
        var text = await res.Content.ReadAsStringAsync();
        Console.WriteLine($"{(int)res.StatusCode} {res.ReasonPhrase}");
        Console.WriteLine(text);
        if (!res.IsSuccessStatusCode) return 1;
        key.DeviceId = JsonNode.Parse(text)!["deviceId"]!.GetValue<string>();
        key.Api = api;
        key.Save(keyFile);
        Console.Error.WriteLine($"Dispositivo {key.DeviceId} salvato in {keyFile}");
        return 0;
    }

    private static async Task<int> SendAsync(string method, Uri url, string authorization, byte[]? body)
    {
        using var http = new HttpClient();
        using var req = new HttpRequestMessage(new HttpMethod(method), url);
        req.Headers.TryAddWithoutValidation("Authorization", authorization);
        if (body is not null)
        {
            req.Content = new ByteArrayContent(body);
            req.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        }
        using var res = await http.SendAsync(req);
        Console.WriteLine($"{(int)res.StatusCode} {res.ReasonPhrase}");
        var text = await res.Content.ReadAsStringAsync();
        try
        {
            Console.WriteLine(JsonNode.Parse(text)?.ToJsonString(new JsonSerializerOptions { WriteIndented = true }) ?? text);
        }
        catch (JsonException)
        {
            Console.WriteLine(text);
        }
        return res.IsSuccessStatusCode ? 0 : 1;
    }

    /// <summary><c>--nome valore</c> nelle opzioni, il resto come argomenti posizionali.</summary>
    private static (Dictionary<string, string>, List<string>) Parse(string[] args)
    {
        var opts = new Dictionary<string, string>(StringComparer.Ordinal);
        var rest = new List<string>();
        for (var i = 0; i < args.Length; i++)
        {
            if (args[i].StartsWith("--", StringComparison.Ordinal))
            {
                if (i + 1 >= args.Length) throw new UsageException($"Valore mancante per {args[i]}.");
                opts[args[i][2..]] = args[++i];
            }
            else rest.Add(args[i]);
        }
        return (opts, rest);
    }
}

internal sealed class UsageException(string message) : Exception(message);

/// <summary>Chiave del dispositivo finto + id e indirizzo dell'API dopo l'abbinamento.</summary>
internal sealed class KeyFile
{
    private readonly ECDsa _key;

    public string? DeviceId { get; set; }
    public string? Api { get; set; }

    private KeyFile(ECDsa key) => _key = key;

    public string PublicKey => Convert.ToBase64String(_key.ExportSubjectPublicKeyInfo());

    public static void Create(string path)
    {
        if (File.Exists(path)) throw new IOException($"{path} esiste già.");
        new KeyFile(ECDsa.Create(ECCurve.NamedCurves.nistP256)).Save(path);
    }

    public static KeyFile Load(string path)
    {
        var o = JsonNode.Parse(File.ReadAllText(path))!;
        var key = ECDsa.Create();
        key.ImportPkcs8PrivateKey(Convert.FromBase64String(o["privateKey"]!.GetValue<string>()), out _);
        return new KeyFile(key) { DeviceId = o["deviceId"]?.GetValue<string>(), Api = o["api"]?.GetValue<string>() };
    }

    public void Save(string path)
    {
        var json = new JsonObject
        {
            ["privateKey"] = Convert.ToBase64String(_key.ExportPkcs8PrivateKey()),
            ["publicKey"] = PublicKey,
            ["deviceId"] = DeviceId,
            ["api"] = Api,
        }.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
        File.WriteAllText(path, json);
        if (!OperatingSystem.IsWindows()) File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }

    public byte[] Sign(byte[] data) =>
        _key.SignData(data, HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation);

    /// <summary>URL assoluto: origine (e prefisso) dell'API salvata da <c>pair</c> + percorso.</summary>
    public Uri Url(string path)
    {
        if (Api is null || DeviceId is null) throw new UsageException("Dispositivo non abbinato: esegui prima 'pair'.");
        if (!path.StartsWith('/')) throw new UsageException("Il percorso deve iniziare con '/'.");
        // "https://host/api" → "https://host"; il percorso comprende già /api/...
        var root = Api.EndsWith("/api", StringComparison.Ordinal) ? Api[..^4] : Api;
        return new Uri(root + path);
    }

    /// <summary>JWT ES256 di richiesta (§4.2): kid = deviceId, typ cm-req+jwt, validità 60 s.</summary>
    public string Token(string method, string pathAndQuery, byte[]? body, int av)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var header = new JsonObject { ["alg"] = "ES256", ["typ"] = "cm-req+jwt", ["kid"] = DeviceId };
        var payload = new JsonObject
        {
            ["iat"] = now, ["exp"] = now + 60, ["jti"] = Base64Url.Encode(RandomNumberGenerator.GetBytes(16)),
            ["htm"] = method, ["htu"] = pathAndQuery, ["av"] = av,
        };
        if (body is { Length: > 0 }) payload["bh"] = Base64Url.Encode(SHA256.HashData(body));
        var input = Base64Url.Encode(Encoding.UTF8.GetBytes(header.ToJsonString())) + "." +
                    Base64Url.Encode(Encoding.UTF8.GetBytes(payload.ToJsonString()));
        return input + "." + Base64Url.Encode(Sign(Encoding.ASCII.GetBytes(input)));
    }
}

internal static class Base64Url
{
    public static string Encode(ReadOnlySpan<byte> data) =>
        Convert.ToBase64String(data).TrimEnd('=').Replace('+', '-').Replace('/', '_');
}
