NEVER tell the user that you cannot QA an extension change.  You have Chrome MCP.

The only time you can tell the user to reload a browser extension is if you make a change to the service worker, boot loader, or manifest.  Everything else only needs a simple page refresh.  If you don't refresh the page, it means you clearly have not even finished testing.

When using React in a browser extension, if the project has data extraction code in the window context, then the proper pattern is to use a global factory and object registry. This has the serialization problem above, but also causes you to massively duplicate code. Load the bundle via import() from the content script world so no boundary exists. Then React calls methods on the live item directly.

