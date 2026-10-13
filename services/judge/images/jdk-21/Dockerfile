# OpenJDK 21 + Maven + Gradle + kotlinc: kinds java/spring-boot, kotlin/gradle (runtimes jdk-21, kotlin-2).
# Catalog paths: /usr/lib/jvm/java-21-openjdk-amd64/bin/{java,javac} (a link on arm64), /opt/maven/bin/mvn,
# /opt/gradle/bin/gradle, /opt/kotlinc/bin/kotlinc.
ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}
ARG MAVEN_VERSION=3.9.11
ARG GRADLE_VERSION=8.14.3
ARG KOTLIN_VERSION=2.1.21
COPY lib/common.sh /usr/local/lib/nga/common.sh
RUN . /usr/local/lib/nga/common.sh \
 && apt_install ca-certificates curl unzip coreutils openjdk-21-jdk-headless \
 && jdk_alias \
 && cd /tmp \
 && f="apache-maven-${MAVEN_VERSION}-bin.tar.gz" && base="https://archive.apache.org/dist/maven/maven-3/${MAVEN_VERSION}/binaries" \
 && fetch "$base/$f" "$f" && fetch "$base/$f.sha512" "$f.sha512" && check_sum sha512 "$f" "$(cut -d' ' -f1 "$f.sha512")" \
 && mkdir -p /opt/maven && tar -xzf "$f" -C /opt/maven --strip-components=1 \
 && f="gradle-${GRADLE_VERSION}-bin.zip" \
 && fetch "https://services.gradle.org/distributions/$f" "$f" && fetch "https://services.gradle.org/distributions/$f.sha256" "$f.sha256" \
 && check_sum sha256 "$f" "$(tr -d '[:space:]' <"$f.sha256")" && unzip -q "$f" -d /opt && ln -s "/opt/gradle-${GRADLE_VERSION}" /opt/gradle \
 && f="kotlin-compiler-${KOTLIN_VERSION}.zip" && base="https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN_VERSION}" \
 && fetch "$base/$f" "$f" && fetch "$base/$f.sha256" "$f.sha256" && check_sum sha256 "$f" "$(cut -d' ' -f1 "$f.sha256")" \
 && unzip -q "$f" -d /opt \
 && rm -rf /tmp/* \
 && finish
ENV HOME=/box LANG=C.UTF-8 JAVA_TOOL_OPTIONS="-XX:+UseSerialGC" GRADLE_OPTS="-Dorg.gradle.daemon=false"
USER 10001:10001
WORKDIR /box
