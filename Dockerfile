FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /build
COPY pom.xml .
COPY src/main src/main
RUN mvn -B compile dependency:copy-dependencies

FROM eclipse-temurin:21-jre
WORKDIR /app
COPY --from=build /build/target/classes ./classes
COPY --from=build /build/target/dependency ./lib
COPY public public
COPY db/migrations db/migrations
ENV BIND_HOST=0.0.0.0
USER 10001
CMD ["java","-cp","classes:lib/*","ru.savepoint.Server"]
