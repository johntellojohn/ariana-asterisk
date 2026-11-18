FROM andrius/asterisk:20

USER root
COPY bridge-entrypoint.sh /usr/local/bin/bridge-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/bridge-entrypoint.sh && chmod +x /usr/local/bin/bridge-entrypoint.sh

EXPOSE 5080/udp 5080/tcp 18000-18060/udp 8088/tcp

ENTRYPOINT ["/usr/local/bin/bridge-entrypoint.sh"]

