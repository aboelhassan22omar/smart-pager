import SwiftUI

/// The AUREXIS brand mark, drawn from https://aurexis.cc/brand/aurexis-mark.svg
/// (viewBox -3 -3 405 392) so it renders offline and stays sharp at any size.
struct AurexisMark: View {
    private static let viewBox = CGRect(x: -3, y: -3, width: 405, height: 392)

    var body: some View {
        Canvas { ctx, size in
            let sx = size.width / Self.viewBox.width
            let sy = size.height / Self.viewBox.height
            func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
                CGPoint(x: (x - Self.viewBox.minX) * sx, y: (y - Self.viewBox.minY) * sy)
            }
            func polygon(_ points: [(CGFloat, CGFloat)]) -> Path {
                var path = Path()
                path.addLines(points.map { pt($0.0, $0.1) })
                path.closeSubpath()
                return path
            }
            func gradient(_ stops: [(UInt32, CGFloat)], from a: CGPoint, to b: CGPoint) -> GraphicsContext.Shading {
                .linearGradient(
                    Gradient(stops: stops.map { Gradient.Stop(color: Color(hex: $0.0), location: $0.1) }),
                    startPoint: a, endPoint: b
                )
            }

            let main = polygon([(0, 385), (0, 285), (269, 0), (269, 110), (16, 370)])
            let fold = polygon([(193, 243), (245, 189), (357, 305), (320, 305), (320, 373)])
            let data = polygon([(341, 326), (399, 326), (399, 386), (341, 386)])

            ctx.fill(main, with: gradient([(0x2DB2FD, 0), (0x327AFA, 0.34), (0x4B4CF4, 0.68), (0x7A6FF9, 1)],
                                          from: pt(269, 0), to: pt(0, 385)))
            ctx.fill(fold, with: gradient([(0x426BF7, 0), (0x514EF4, 0.5), (0x613BF2, 1)],
                                          from: pt(245, 189), to: pt(320, 373)))
            ctx.fill(data, with: gradient([(0x4965F5, 0), (0x5148F3, 1)],
                                          from: pt(370, 326), to: pt(370, 386)))

            let edge = gradient([(0x8BE8FF, 0), (0x829BFF, 0.5), (0xA88CFF, 1)], from: pt(269, 0), to: pt(0, 385))
            for path in [main, fold, data] {
                ctx.stroke(path, with: edge, lineWidth: max(0.5, 1.5 * sx))
            }
        }
        .aspectRatio(Self.viewBox.width / Self.viewBox.height, contentMode: .fit)
        .accessibilityHidden(true)
    }
}
