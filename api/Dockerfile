# Immagine dell'API CineManager. Build context: la cartella api/
#   docker build -t moviecarousel-api api/
# Gira come utente non-root ($APP_UID delle immagini ufficiali), porta 8080, compatibile con
# read_only: true + tmpfs /tmp (chiavi Data Protection nel DB, certificato caricato in memoria).

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS build
WORKDIR /src
COPY CineManager.Api/CineManager.Api.csproj CineManager.Api/
RUN dotnet restore CineManager.Api/CineManager.Api.csproj
COPY CineManager.Api/ CineManager.Api/
RUN dotnet publish CineManager.Api/CineManager.Api.csproj -c Release -o /app --no-restore /p:UseAppHost=false

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
ENV ASPNETCORE_HTTP_PORTS=8080 \
    DOTNET_EnableDiagnostics=0 \
    DOTNET_gcServer=0
COPY --from=build /app .
USER $APP_UID
EXPOSE 8080
ENTRYPOINT ["dotnet", "CineManager.Api.dll"]
