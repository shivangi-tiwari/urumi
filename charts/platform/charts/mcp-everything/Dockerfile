FROM node:22.12-alpine

RUN npm install --global @modelcontextprotocol/server-everything@1.0.0 \
    && npm cache clean --force

ENV PORT=3001

USER node

EXPOSE 3001

ENTRYPOINT ["mcp-server-everything"]
CMD ["streamableHttp"]
