using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json.Nodes;
using CineManager.Api.Auth;
using CineManager.Api.Endpoints;
using CineManager.Api.Tests.Support;
using Microsoft.AspNetCore.Builder;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;

namespace CineManager.Api.Tests;

/// <summary>Abbinamento (§4.2) e verifica delle richieste firmate dell'app.</summary>
public class DeviceAuthTests(AppFixture fx) : IClassFixture<AppFixture>
{
    private AppFactory F => fx.Factory;

    private static async Task<JsonObject> Obj(HttpResponseMessage res) =>
        (JsonObject)JsonNode.Parse(await res.Content.ReadAsStringAsync())!;

    private static async Task<string?> Reason(HttpResponseMessage res) =>
        (await Obj(res))["reason"]?.GetValue<string>();

    private async Task<string> NewCode(string user = "alice")
    {
        using var site = F.Client(user);
        var res = await site.PostAsync("/api/pairing", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        return (await Obj(res))["code"]!.GetValue<string>();
    }

    private Task<HttpResponseMessage> Pair(object body)
    {
        var c = F.AppClient();
        return c.PostAsJsonAsync("/api/app/pair", body);
    }

    // --- abbinamento ---------------------------------------------------------------------------

    [DbFact]
    public async Task Pairing_restituisce_codice_qr_e_salva_solo_l_hash()
    {
        using var site = F.Client("alice");
        var res = await site.PostAsync("/api/pairing", null);
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var o = await Obj(res);
        var code = o["code"]!.GetValue<string>();
        Assert.Equal(22, code.Length); // 128 bit in base64url senza padding
        Assert.NotNull(Base64Url.TryDecode(code));
        var expires = o["expiresAt"]!.GetValue<DateTimeOffset>();
        Assert.InRange(expires - DateTimeOffset.UtcNow, TimeSpan.FromMinutes(4), TimeSpan.FromMinutes(5.1));
        var svg = o["qrSvg"]!.GetValue<string>();
        Assert.Contains("<svg", svg);

        var hash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(code));
        var stored = await F.WithDbAsync(db => db.PairingCodes.AsNoTracking().SingleAsync(p => p.CodeHash == hash));
        Assert.Equal("alice", stored.UserSub);
        Assert.Null(stored.UsedAt);
    }

    [DbFact]
    public async Task Pairing_richiede_utente_e_csrf()
    {
        using var anon = F.Client(user: null);
        Assert.Equal(HttpStatusCode.Unauthorized, (await anon.PostAsync("/api/pairing", null)).StatusCode);
        using var noCsrf = F.Client("alice", csrf: false);
        Assert.Equal(HttpStatusCode.BadRequest, (await noCsrf.PostAsync("/api/pairing", null)).StatusCode);
        using var noRole = F.Client("eve", roles: "");
        Assert.Equal(HttpStatusCode.Forbidden, (await noRole.PostAsync("/api/pairing", null)).StatusCode);
    }

    [DbFact]
    public async Task Pair_crea_il_dispositivo_e_il_codice_e_monouso()
    {
        var code = await NewCode();
        using var dev = new TestDevice();
        var res = await Pair(new { code, deviceName = "Pixel", publicKey = dev.PublicKey, proof = dev.Proof(code) });
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var o = await Obj(res);
        Assert.Equal("ALICE", o["user"]!["name"]!.GetValue<string>());
        var id = Guid.Parse(o["deviceId"]!.GetValue<string>());
        var device = await F.WithDbAsync(db => db.Devices.AsNoTracking().SingleAsync(d => d.Id == id));
        Assert.Equal(("alice", "Pixel"), (device.UserSub, device.Name));
        Assert.Equal(Convert.FromBase64String(dev.PublicKey), device.PublicKey);

        using var other = new TestDevice();
        var again = await Pair(new { code, deviceName = "Altro", publicKey = other.PublicKey, proof = other.Proof(code) });
        Assert.Equal(HttpStatusCode.BadRequest, again.StatusCode);
        Assert.Equal("invalid_code", await Reason(again));
    }

    [DbFact]
    public async Task Pair_codice_scaduto_o_sbagliato_400()
    {
        var code = await NewCode();
        var hash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(code));
        await F.WithDbAsync(db => db.PairingCodes.Where(p => p.CodeHash == hash)
            .ExecuteUpdateAsync(s => s.SetProperty(p => p.ExpiresAt, DateTimeOffset.UtcNow.AddSeconds(-1))));
        using var dev = new TestDevice();
        var expired = await Pair(new { code, deviceName = "P", publicKey = dev.PublicKey, proof = dev.Proof(code) });
        Assert.Equal(HttpStatusCode.BadRequest, expired.StatusCode);
        Assert.Equal("invalid_code", await Reason(expired));

        var wrong = Base64Url.Encode(RandomNumberGenerator.GetBytes(16));
        var bad = await Pair(new { code = wrong, deviceName = "P", publicKey = dev.PublicKey, proof = dev.Proof(wrong) });
        Assert.Equal(HttpStatusCode.BadRequest, bad.StatusCode);
        Assert.Equal("invalid_code", await Reason(bad));
    }

    [DbFact]
    public async Task Pair_proof_errata_non_consuma_il_codice()
    {
        var code = await NewCode();
        using var dev = new TestDevice();
        using var other = new TestDevice();
        // Firma di un altro messaggio, e firma con un'altra chiave.
        foreach (var proof in new[] { dev.Proof(code + "x"), other.Proof(code), "abc" })
        {
            var res = await Pair(new { code, deviceName = "P", publicKey = dev.PublicKey, proof });
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Equal("invalid_proof", await Reason(res));
        }
        var ok = await Pair(new { code, deviceName = "P", publicKey = dev.PublicKey, proof = dev.Proof(code) });
        Assert.Equal(HttpStatusCode.OK, ok.StatusCode);
    }

    [DbFact]
    public async Task Pair_rifiuta_chiavi_non_P256()
    {
        var code = await NewCode();
        using var p384 = ECDsa.Create(ECCurve.NamedCurves.nistP384);
        using var rsa = RSA.Create(2048);
        var proof = Base64Url.Encode(new byte[64]);
        foreach (var key in new[] { p384.ExportSubjectPublicKeyInfo(), rsa.ExportSubjectPublicKeyInfo(), [1, 2, 3] })
        {
            var res = await Pair(new { code, deviceName = "P", publicKey = Convert.ToBase64String(key), proof });
            Assert.Equal(HttpStatusCode.BadRequest, res.StatusCode);
            Assert.Equal("invalid_key", await Reason(res));
        }
    }

    [DbFact]
    public async Task Pair_campi_mancanti_o_nome_non_valido_400()
    {
        var code = await NewCode();
        using var dev = new TestDevice();
        var missing = await Pair(new { code, publicKey = dev.PublicKey, proof = dev.Proof(code) });
        Assert.Equal(HttpStatusCode.BadRequest, missing.StatusCode);
        var longName = await Pair(new { code, deviceName = new string('x', 101), publicKey = dev.PublicKey, proof = dev.Proof(code) });
        Assert.Equal(HttpStatusCode.BadRequest, longName.StatusCode);
    }

    // --- richieste firmate ---------------------------------------------------------------------

    [DbFact]
    public async Task Me_con_firma_valida_aggiorna_last_seen()
    {
        using var dev = await F.PairAsync("alice", "Telefono");
        using var c = F.AppClient();
        var res = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var o = await Obj(res);
        Assert.Equal(dev.Id.ToString(), o["deviceId"]!.GetValue<string>());
        Assert.Equal("Telefono", o["deviceName"]!.GetValue<string>());
        Assert.Equal("ALICE", o["user"]!["name"]!.GetValue<string>());
        var seen = await F.WithDbAsync(db => db.Devices.AsNoTracking().Where(d => d.Id == dev.Id).Select(d => d.LastSeenAt).SingleAsync());
        Assert.NotNull(seen);
    }

    [DbFact]
    public async Task Senza_firma_o_con_cookie_del_sito_401()
    {
        using var anon = F.AppClient();
        var res = await anon.GetAsync("/api/app/me");
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
        // L'identità del sito non vale per /api/app/*.
        using var site = F.Client("alice");
        Assert.Equal(HttpStatusCode.Unauthorized, (await site.GetAsync("/api/app/me")).StatusCode);
    }

    public static TheoryData<string> Tampered => new()
    {
        "scaduto", "futuro", "durata_oltre_60", "exp_prima_di_iat", "htm", "htu", "htu_query", "typ", "kid_altro",
        "alg_none", "alg_hs256", "alg_es384", "firma_altra_chiave", "firma_corta", "senza_jti", "senza_av",
    };

    [DbTheory]
    [MemberData(nameof(Tampered))]
    public async Task Token_alterato_401(string caso)
    {
        using var dev = await F.PairAsync();
        using var other = new TestDevice();
        var now = DateTimeOffset.UtcNow;
        Action<JsonObject, JsonObject>? tamper = null;
        Func<byte[], byte[]>? sign = null;
        DateTimeOffset? at = null;
        var method = HttpMethod.Get;
        var path = "/api/app/me";
        switch (caso)
        {
            case "scaduto": at = now.AddSeconds(-95); break; // exp = now - 35 s, oltre la tolleranza
            case "futuro": at = now.AddSeconds(45); break;
            case "durata_oltre_60": tamper = (_, p) => p["exp"] = p["iat"]!.GetValue<long>() + 61; break;
            case "exp_prima_di_iat": tamper = (_, p) => p["exp"] = p["iat"]!.GetValue<long>() - 1; break;
            case "htm": tamper = (_, p) => p["htm"] = "DELETE"; break;
            case "htu": tamper = (_, p) => p["htu"] = "/api/app/fields"; break;
            case "htu_query": path = "/api/app/me?x=1"; tamper = (_, p) => p["htu"] = "/api/app/me"; break;
            case "typ": tamper = (h, _) => h["typ"] = "JWT"; break;
            case "kid_altro": tamper = (h, _) => h["kid"] = Guid.NewGuid().ToString(); break;
            case "alg_none": tamper = (h, _) => h["alg"] = "none"; sign = _ => []; break;
            case "alg_hs256":
                tamper = (h, _) => h["alg"] = "HS256";
                sign = data => HMACSHA256.HashData(dev.Key.ExportSubjectPublicKeyInfo(), data);
                break;
            case "alg_es384": tamper = (h, _) => h["alg"] = "ES384"; break;
            case "firma_altra_chiave": sign = other.Sign; break;
            case "firma_corta": sign = data => dev.Sign(data)[..63]; break;
            case "senza_jti": tamper = (_, p) => p.Remove("jti"); break;
            case "senza_av": tamper = (_, p) => p.Remove("av"); break;
        }
        using var c = F.AppClient();
        var res = await c.SendAsync(dev.Request(method, path, null, at, tamper, sign));
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
    }

    [DbFact]
    public async Task Tolleranza_di_30_secondi_sull_orologio()
    {
        using var dev = await F.PairAsync();
        using var c = F.AppClient();
        // iat 25 s nel futuro, e token scaduto da 20 s: entrambi accettati.
        var ahead = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me", now: DateTimeOffset.UtcNow.AddSeconds(25)));
        Assert.Equal(HttpStatusCode.OK, ahead.StatusCode);
        var late = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me", now: DateTimeOffset.UtcNow.AddSeconds(-80)));
        Assert.Equal(HttpStatusCode.OK, late.StatusCode);
    }

    [DbFact]
    public async Task Jti_ripetuto_401()
    {
        using var dev = await F.PairAsync();
        using var c = F.AppClient();
        var first = dev.Request(HttpMethod.Get, "/api/app/me");
        var auth = first.Headers.Authorization!.ToString();
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(first)).StatusCode);
        var replay = new HttpRequestMessage(HttpMethod.Get, "/api/app/me");
        replay.Headers.TryAddWithoutValidation("Authorization", auth);
        var res = await c.SendAsync(replay);
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("replay", await Reason(res));
    }

    [DbFact]
    public async Task Corpo_senza_bh_o_alterato_401()
    {
        using var dev = await F.PairAsync();
        using var c = F.AppClient();
        const string body = """{"movie":{"title":"X"}}""";
        var noBh = await c.SendAsync(dev.Request(HttpMethod.Post, "/api/app/movies", body, tamper: (_, p) => p.Remove("bh")));
        Assert.Equal(HttpStatusCode.Unauthorized, noBh.StatusCode);
        Assert.Equal("bh_missing", await Reason(noBh));

        var req = dev.Request(HttpMethod.Post, "/api/app/movies", body);
        req.Content = new StringContent("""{"movie":{"title":"Y"}}""", System.Text.Encoding.UTF8, "application/json");
        var altered = await c.SendAsync(req);
        Assert.Equal(HttpStatusCode.Unauthorized, altered.StatusCode);
        Assert.Equal("bh_mismatch", await Reason(altered));
    }

    [DbFact]
    public async Task Dispositivo_revocato_401_anche_dopo_scollega()
    {
        using var dev = await F.PairAsync();
        using var c = F.AppClient();
        Assert.Equal(HttpStatusCode.NoContent, (await c.SendAsync(dev.Request(HttpMethod.Delete, "/api/app/me"))).StatusCode);
        var revoked = await F.WithDbAsync(db => db.Devices.AsNoTracking().Where(d => d.Id == dev.Id).Select(d => d.RevokedAt).SingleAsync());
        Assert.NotNull(revoked);
        var res = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me"));
        Assert.Equal(HttpStatusCode.Unauthorized, res.StatusCode);
        Assert.Equal("device_revoked", await Reason(res));
    }

    [DbFact]
    public async Task Proprietario_inattivo_403_owner_inactive()
    {
        using var dev = await F.PairAsync("olga");
        await F.WithDbAsync(db => db.Users.Where(u => u.Sub == "olga")
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.LastLoginAt, DateTimeOffset.UtcNow.AddDays(-91))));
        using var c = F.AppClient();
        var res = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me"));
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("application/problem+json", res.Content.Headers.ContentType?.MediaType);
        Assert.Equal("owner_inactive", await Reason(res));

        await F.WithDbAsync(db => db.Users.Where(u => u.Sub == "olga")
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.LastLoginAt, DateTimeOffset.UtcNow.AddDays(-89))));
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me"))).StatusCode);
    }

    [DbFact]
    public async Task Versione_sotto_il_minimo_426()
    {
        using var dev = await F.PairAsync();
        dev.VersionCode = AppFactory.MinSupportedCode - 1;
        using var c = F.AppClient();
        var res = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me"));
        Assert.Equal(HttpStatusCode.UpgradeRequired, res.StatusCode);
        var o = await Obj(res);
        Assert.Equal("upgrade_required", o["reason"]!.GetValue<string>());
        Assert.Equal(AppFactory.MinSupportedCode, o["minSupportedCode"]!.GetValue<int>());
        dev.VersionCode = AppFactory.MinSupportedCode;
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me"))).StatusCode);
    }

    [DbFact]
    public async Task App_fields_solo_campi_del_modulo()
    {
        using var dev = await F.PairAsync();
        using var c = F.AppClient();
        var res = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/fields"));
        Assert.Equal(HttpStatusCode.OK, res.StatusCode);
        var arr = JsonNode.Parse(await res.Content.ReadAsStringAsync())!.AsArray();
        Assert.Contains(arr, f => f!["name"]!.GetValue<string>() == "title");
        Assert.All(arr, f => Assert.True(f!["inForm"]!.GetValue<bool>()));
        Assert.DoesNotContain(arr, f => f!["type"]!.GetValue<string>() is "image" or "dependent");
    }

    [DbFact]
    public async Task Corpo_oltre_256_KB_413()
    {
        using var dev = await F.PairAsync();
        using var c = F.AppClient();
        var big = """{"movie":{"title":"X","plot":""" + "\"" + new string('a', 300 * 1024) + "\"}}";
        var res = await c.SendAsync(dev.Request(HttpMethod.Post, "/api/app/movies", big));
        Assert.Equal(HttpStatusCode.RequestEntityTooLarge, res.StatusCode);
    }
}

/// <summary>Rate limit di <c>/api/app/pair</c> (host dedicato con limiti bassi).</summary>
public class PairRateLimitTests : IDisposable
{
    private readonly AppFactory? _f;

    public PairRateLimitTests()
    {
        if (TestDb.BaseConnection is null) return;
        _f = new AppFactory();
        _f.Settings["RateLimit:PairPerIp"] = "3";
        _f.Settings["RateLimit:PairGlobal"] = "5";
    }

    [DbFact]
    public async Task Pair_oltre_il_limite_429()
    {
        using var c = _f!.AppClient();
        var codes = new List<HttpStatusCode>();
        for (var i = 0; i < 4; i++)
            codes.Add((await c.PostAsJsonAsync("/api/app/pair", new { code = "x" })).StatusCode);
        Assert.Equal([HttpStatusCode.BadRequest, HttpStatusCode.BadRequest, HttpStatusCode.BadRequest, HttpStatusCode.TooManyRequests], codes);
        // Le altre richieste non sono toccate dal limite di pair.
        using var site = _f.Client("alice");
        Assert.Equal(HttpStatusCode.OK, (await site.GetAsync("/api/me")).StatusCode);
    }

    public void Dispose() => _f?.Dispose();
}

/// <summary>Rate limit di lookup/search per dispositivo: il secchio è IP + kid (host dedicato).</summary>
public class LookupRateLimitTests : IDisposable
{
    private sealed class IpFactory : AppFactory
    {
        public const string IpHeader = "X-Test-Ip";

        protected override void ConfigureWebHost(Microsoft.AspNetCore.Hosting.IWebHostBuilder builder)
        {
            base.ConfigureWebHost(builder);
            builder.ConfigureServices(s => s.AddSingleton<Microsoft.AspNetCore.Hosting.IStartupFilter, IpFilter>());
        }

        /// <summary>IP del client da un header di test (TestServer non ne ha uno).</summary>
        private sealed class IpFilter : Microsoft.AspNetCore.Hosting.IStartupFilter
        {
            public Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> Configure(Action<Microsoft.AspNetCore.Builder.IApplicationBuilder> next) => app =>
            {
                app.Use(async (Microsoft.AspNetCore.Http.HttpContext ctx, Func<Task> n) =>
                {
                    if (ctx.Request.Headers.TryGetValue(IpHeader, out var ip)) ctx.Connection.RemoteIpAddress = IPAddress.Parse(ip.ToString());
                    await n();
                });
                next(app);
            };
        }
    }

    private readonly IpFactory? _f;

    public LookupRateLimitTests()
    {
        if (TestDb.BaseConnection is null) return;
        _f = new IpFactory();
        _f.Settings["RateLimit:LookupPerDevice"] = "2";
    }

    [DbFact]
    public async Task Chi_conosce_il_kid_da_un_altro_IP_non_esaurisce_il_budget_del_telefono()
    {
        using var dev = await _f!.PairAsync();
        using var c = _f.AppClient();
        const string path = "/api/app/lookup?ean=8012345678901";

        HttpRequestMessage From(string ip, HttpRequestMessage req)
        {
            req.Headers.Add(IpFactory.IpHeader, ip);
            return req;
        }

        // Attaccante: token falsi con il kid del telefono, da un altro IP.
        for (var i = 0; i < 3; i++)
            await c.SendAsync(From("10.0.0.66", dev.Request(HttpMethod.Get, path, sign: _ => new byte[64])));
        Assert.Equal(HttpStatusCode.TooManyRequests,
            (await c.SendAsync(From("10.0.0.66", dev.Request(HttpMethod.Get, path, sign: _ => new byte[64])))).StatusCode);

        // Il telefono vero ha ancora il suo budget, che poi si esaurisce normalmente.
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(From("10.0.0.1", dev.Request(HttpMethod.Get, path)))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(From("10.0.0.1", dev.Request(HttpMethod.Get, path)))).StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, (await c.SendAsync(From("10.0.0.1", dev.Request(HttpMethod.Get, path)))).StatusCode);
    }

    public void Dispose() => _f?.Dispose();
}

/// <summary>Formato del token, senza host.</summary>
public class DeviceTokenUnitTests
{
    [Fact]
    public void Base64Url_rifiuta_padding_e_alfabeto_standard()
    {
        Assert.Null(Base64Url.TryDecode("ab=="));
        Assert.Null(Base64Url.TryDecode("a+b/"));
        Assert.Equal([0xfb, 0xff], Base64Url.TryDecode("-_8"));
    }

    [Fact]
    public void ImportP256_accetta_solo_P256()
    {
        using var p256 = ECDsa.Create(ECCurve.NamedCurves.nistP256);
        using var p521 = ECDsa.Create(ECCurve.NamedCurves.nistP521);
        using var ok = DeviceTokens.ImportP256(p256.ExportSubjectPublicKeyInfo());
        Assert.NotNull(ok);
        Assert.Null(DeviceTokens.ImportP256(p521.ExportSubjectPublicKeyInfo()));
        Assert.Null(DeviceTokens.ImportP256([.. p256.ExportSubjectPublicKeyInfo(), 0]));
    }

    [Fact]
    public void TryParse_alg_diverso_unsupported_alg()
    {
        using var dev = new TestDevice { Id = Guid.NewGuid() };
        var token = dev.Token("GET", "/api/app/me", null, tamper: (h, _) => h["alg"] = "RS256");
        Assert.Null(DeviceTokens.TryParse(token, out var error));
        Assert.Equal("unsupported_alg", error);
        Assert.NotNull(DeviceTokens.TryParse(dev.Token("GET", "/api/app/me", null), out _));
    }

    [Fact]
    public void ReplayCache_scade_dopo_la_validita_del_token()
    {
        var clock = new ManualClock(DateTimeOffset.FromUnixTimeSeconds(1_800_000_000));
        var cache = new ReplayCache(clock);
        var id = Guid.NewGuid();
        var exp = clock.GetUtcNow().ToUnixTimeSeconds() + 60;
        Assert.True(cache.TryRegister(id, "jti-0123456789abcdef", exp));
        Assert.False(cache.TryRegister(id, "jti-0123456789abcdef", exp));
        Assert.True(cache.TryRegister(Guid.NewGuid(), "jti-0123456789abcdef", exp));
        clock.Advance(TimeSpan.FromSeconds(60 + DeviceAuthHandler.ClockSkewSeconds + 1) + ReplayCache.Margin + TimeSpan.FromSeconds(1));
        Assert.True(cache.TryRegister(id, "jti-0123456789abcdef", exp));
    }

    [Fact]
    public void ReplayCache_nessun_replay_al_confine_della_finestra()
    {
        // Token con iat al limite della tolleranza nel futuro (now + 30) e durata massima (60 s):
        // l'API lo accetta fino a now + 120 s compreso (exp ≥ floor(now) - 30).
        var t0 = DateTimeOffset.FromUnixTimeSeconds(1_800_000_000).AddMilliseconds(100);
        var clock = new ManualClock(t0);
        var cache = new ReplayCache(clock);
        var id = Guid.NewGuid();
        var exp = t0.ToUnixTimeSeconds() + DeviceAuthHandler.ClockSkewSeconds + DeviceAuthHandler.MaxLifetimeSeconds;
        Assert.True(cache.TryRegister(id, "jti-confine-0123456789", exp));

        clock.Advance(TimeSpan.FromSeconds(120.5)); // ancora accettabile: floor(now) - 30 = exp
        Assert.True(exp >= clock.GetUtcNow().ToUnixTimeSeconds() - DeviceAuthHandler.ClockSkewSeconds);
        Assert.False(cache.TryRegister(id, "jti-confine-0123456789", exp));
    }

    [Fact]
    public void Hash_del_codice_e_sha256()
    {
        Assert.Equal(SHA256.HashData("abc"u8), PairingEndpoints.Hash("abc"));
    }
}

/// <summary>Orologio manuale per i test.</summary>
public sealed class ManualClock(DateTimeOffset now) : TimeProvider
{
    private DateTimeOffset _now = now;
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(TimeSpan by) => _now += by;
}

/// <summary>Con <c>Oidc__UserGroup</c> impostato il proprietario deve avere avuto il gruppo all'ultimo login (§4.3).</summary>
public class OwnerGroupTests : IDisposable
{
    private readonly AppFactory? _f;

    public OwnerGroupTests()
    {
        if (TestDb.BaseConnection is null) return;
        _f = new AppFactory();
        _f.Settings["Oidc:UserGroup"] = "cinema";
    }

    [DbFact]
    public async Task Proprietario_senza_gruppo_403_poi_con_gruppo_ok()
    {
        // L'autenticazione di test registra l'utente senza gruppi.
        using var dev = await _f!.PairAsync("gino");
        using var c = _f.AppClient();
        var res = await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me"));
        Assert.Equal(HttpStatusCode.Forbidden, res.StatusCode);
        Assert.Equal("owner_inactive", JsonNode.Parse(await res.Content.ReadAsStringAsync())!["reason"]!.GetValue<string>());

        await _f.WithDbAsync(db => db.Users.Where(u => u.Sub == "gino")
            .ExecuteUpdateAsync(s => s.SetProperty(u => u.Groups, new List<string> { "cinema" })));
        Assert.Equal(HttpStatusCode.OK, (await c.SendAsync(dev.Request(HttpMethod.Get, "/api/app/me"))).StatusCode);
    }

    public void Dispose() => _f?.Dispose();
}
