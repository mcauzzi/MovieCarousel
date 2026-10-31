using CineManager.Api.Auth;
using CineManager.Api.Data;
using CineManager.Api.Endpoints;
using CineManager.Api.Import;
using CineManager.Api.Infrastructure;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

var connectionString = builder.Configuration.GetConnectionString("Cinema");
if (string.IsNullOrWhiteSpace(connectionString))
    throw new InvalidOperationException("ConnectionStrings__Cinema mancante.");

builder.Services.AddDbContext<CinemaDbContext>(o => o.UseNpgsql(connectionString));
builder.Services.AddMemoryCache();
builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddProblemDetails();
builder.Services.Configure<CoversOptions>(builder.Configuration.GetSection(CoversOptions.Section));
builder.Services.Configure<TellicoOptions>(builder.Configuration.GetSection(TellicoOptions.Section));
builder.Services.AddScoped<CoverStore>();
builder.Services.AddScoped<TellicoImporter>();

// Corpo massimo di default 1 MB; gli import alzano il limite con [RequestSizeLimit].
builder.WebHost.ConfigureKestrel(k => k.Limits.MaxRequestBodySize = 1024 * 1024);

if (!builder.Environment.IsDevelopment())
{
    if (string.IsNullOrWhiteSpace(builder.Configuration["Covers:Path"]))
        throw new InvalidOperationException("Covers__Path mancante.");
}

builder.AddCineForwardedHeaders();
builder.AddCineDataProtection();
builder.AddCineRateLimiter();
builder.AddCineAuth();

var app = builder.Build();

// Migrazioni all'avvio: c'è una sola istanza dell'API.
using (var scope = app.Services.CreateScope())
    await scope.ServiceProvider.GetRequiredService<CinemaDbContext>().Database.MigrateAsync();

app.UseForwardedHeaders();
app.UseExceptionHandler();
app.UseStatusCodePages();
app.UseRateLimiter();
app.UseMiddleware<CsrfMiddleware>();
app.UseAuthentication();
app.UseAuthorization();

app.MapAuthEndpoints();
app.MapCollectionEndpoints();
app.MapStateEndpoints();
app.MapImportEndpoints();

app.Run();

public partial class Program;
