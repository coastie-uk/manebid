    const folderPath = "./downloads/";

    const statusEl = document.getElementById("status");
    const listEl = document.getElementById("file-list");
    const emptyEl = document.getElementById("empty");

    function formatBytes(bytes) {
      if (!Number.isFinite(bytes) || bytes < 0) return "Unknown";
      if (bytes === 0) return "0 B";
      const units = ["B", "KB", "MB", "GB", "TB"];
      const exp = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
      const value = bytes / (1024 ** exp);
      return `${value.toFixed(value >= 10 || exp === 0 ? 0 : 1)} ${units[exp]}`;
    }

    function fallbackTypeFromName(fileName) {
      const ext = fileName.split(".").pop()?.toLowerCase();
      if (!ext || ext === fileName.toLowerCase()) return "Unknown";
      return ext.toUpperCase();
    }

    async function getFileMeta(url, fileName) {
      try {
        const headRes = await fetch(url, { method: "HEAD" });
        if (headRes.ok) {
          const size = Number(headRes.headers.get("content-length"));
          const contentType = headRes.headers.get("content-type");
          return {
            size,
            type: contentType ? contentType.split(";")[0] : fallbackTypeFromName(fileName)
          };
        }
      } catch (_) {
        // fall through to GET request
      }

      try {
        const getRes = await fetch(url);
        if (!getRes.ok) throw new Error("GET failed");
        const blob = await getRes.blob();
        return {
          size: blob.size,
          type: blob.type || fallbackTypeFromName(fileName)
        };
      } catch (_) {
        return {
          size: NaN,
          type: fallbackTypeFromName(fileName)
        };
      }
    }

    async function loadFileList() {
      try {
        const indexRes = await fetch(folderPath);
        if (!indexRes.ok) {
          throw new Error(`Failed to read folder index: ${indexRes.status}`);
        }

        const html = await indexRes.text();
        const doc = new DOMParser().parseFromString(html, "text/html");
        const links = Array.from(doc.querySelectorAll("a"));

        const fileNames = links
          .map((a) => (a.getAttribute("href") || "").trim())
          .map((href) => href.split("?")[0].split("#")[0])
          .filter((href) => href && href !== "../" && href !== "/" && !href.endsWith("/"))
          .map((href) => {
            const part = href.split("/").pop();
            try {
              return decodeURIComponent(part || "");
            } catch (_) {
              return part || "";
            }
          })
          .filter(Boolean)
          .filter((name, index, arr) => arr.indexOf(name) === index)
          .sort((a, b) => a.localeCompare(b));

        if (fileNames.length === 0) {
          statusEl.textContent = "Loaded 0 files.";
          emptyEl.hidden = false;
          return;
        }

        const rows = await Promise.all(fileNames.map(async (name) => {
          const url = `${folderPath}${encodeURIComponent(name)}`;
          const meta = await getFileMeta(url, name);
          return { name, url, ...meta };
        }));

        const fragment = document.createDocumentFragment();

        for (const file of rows) {
          const tr = document.createElement("tr");
          const nameCell = document.createElement("td");
          nameCell.className = "file-name";
          nameCell.textContent = file.name;

          const sizeCell = document.createElement("td");
          sizeCell.textContent = formatBytes(file.size);

          const typeCell = document.createElement("td");
          typeCell.textContent = file.type;

          const actionCell = document.createElement("td");
          const link = document.createElement("a");
          link.className = "download-link";
          link.href = file.url;
          link.setAttribute("download", "");
          link.textContent = "Download";
          actionCell.appendChild(link);

          tr.append(nameCell, sizeCell, typeCell, actionCell);
          fragment.appendChild(tr);
        }

        listEl.appendChild(fragment);
        statusEl.textContent = `Loaded ${rows.length} file${rows.length === 1 ? "" : "s"}.`;
      } catch (error) {
        statusEl.textContent = "Could not load folder listing. Ensure your static server exposes directory indexes for downloads/.";
        console.error(error);
      }
    }

    loadFileList();
