
import { fileTreeFileIcon, type FileTreeIconSpec } from "../../file-tree-icons";
import { FileIconFrame } from "./FileIconFrame";

export function FileTypeIcon({ path }: { path: string }) { return <FileTreeIconFrame iconSpec={fileTreeFileIcon(path)} />; }
function FileTreeIconFrame({ iconSpec }: { iconSpec: FileTreeIconSpec }) { return <FileIconFrame iconSpec={iconSpec} />; }
