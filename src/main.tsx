import React from "react";
import ReactDOM from "react-dom/client";
import RecordingBar from "./components/RecordingBar";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <div className="w-screen h-screen m-0 p-0 overflow-hidden">
      <RecordingBar />
    </div>
  </React.StrictMode>
);
