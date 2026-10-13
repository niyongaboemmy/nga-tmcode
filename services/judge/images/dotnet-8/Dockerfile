# .NET 8 SDK (C#, F#, VB): kinds csharp/*, fsharp/*, vb/console. amd64 + arm64 (Ubuntu's dotnet8 packages).
# Catalog paths: /usr/bin/dotnet.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates coreutils dotnet-sdk-8.0 \
 && finish
ENV HOME=/box LANG=C.UTF-8 DOTNET_CLI_TELEMETRY_OPTOUT=1 DOTNET_NOLOGO=1 DOTNET_SKIP_FIRST_TIME_EXPERIENCE=1 \
    DOTNET_GENERATE_ASPNET_CERTIFICATE=false NUGET_XMLDOC_MODE=skip MSBUILDDISABLENODEREUSE=1 DOTNET_gcServer=0
USER 10001:10001
WORKDIR /box
